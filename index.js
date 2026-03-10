const express = require('express');
const { processWebhookData } = require('./utils');
const bridalLiveService = require('./bridallive-service');
const shopifyService = require('./shopify-service');
const config = require('./config');
const app = express();
const PORT = config.server.port;

// Función para manejar objetos con referencias circulares
function safeStringify(obj, space = 2) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, val) => {
    if (val != null && typeof val === "object") {
      if (seen.has(val)) {
        return "[Circular]";
      }
      seen.add(val);
    }
    return val;
  }, space);
}

// CORS: permitir cualquier origen
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Middleware para parsear JSON
app.use(express.json());

// Middleware para parsear datos de formularios
app.use(express.urlencoded({ extended: true }));

// Middleware personalizado para manejar text/plain con JSON
app.use((req, res, next) => {
  if (req.get('Content-Type') === 'text/plain' && req.method === 'POST') {
    let data = '';
    req.setEncoding('utf8');
    
    req.on('data', (chunk) => {
      data += chunk;
    });
    
    req.on('end', () => {
      try {
        // Intentar parsear como JSON
        const parsed = JSON.parse(data);
        
        // Si es un array con value, procesar el value
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].value) {
          try {
            // Parsear el JSON dentro de value
            req.body = JSON.parse(parsed[0].value);
          } catch (innerError) {
            // Si no se puede parsear el value, mantener el array original
            req.body = parsed;
          }
        } else {
          req.body = parsed;
        }
      } catch (error) {
        // Si no es JSON válido, mantener como string
        req.body = data;
      }
      next();
    });
  } else {
    next();
  }
});


// Endpoint principal para webhooks
app.post('/webhook', async (req, res) => {
  console.log('=== WEBHOOK RECIBIDO ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Content Type:', req.get('Content-Type'));
  console.log('Content Length:', req.get('Content-Length'));
  
  // Procesar el webhook con validación Zod
  const result = processWebhookData(req.body);
  
  if (result.success) {
    console.log('\n✅ WEBHOOK PROCESADO EXITOSAMENTE');
    
    // Mostrar datos del contacto
    if (result.data.contact) {
      console.log('\n📞 CONTACTO:');
      console.log('  - ID:', result.data.contact.externalId);
      console.log('  - Nombre:', result.data.contact.firstName, result.data.contact.lastName);
      console.log('  - Email:', result.data.contact.email);
      console.log('  - Teléfono:', result.data.contact.phone);
      console.log('  - Estado:', result.data.contact.state);
      console.log('  - País:', result.data.contact.country);
      console.log('  - PIN:', result.data.contact.pin);
      console.log('  - Fecha creación:', new Date(result.data.contact.createdDate).toISOString());
      
      // Obtener descripción de la categoría (priorizar appointment sobre contacto)
      let categoryDescription = 'Unassigned';

      // Primero verificar si hay appointment con categoría más específica
      if (result.data.raw.appointment && result.data.raw.appointment.categoryDescription) {

        // Detectar si hay inconsistencia entre status y categoría (timing issue)
        const appointmentStatus = result.data.raw.appointment.status;
        const appointmentCategory = result.data.raw.appointment.categoryDescription;

        console.log('  - Status del Appointment:', appointmentStatus);
        console.log('  - Categoría del Appointment:', appointmentCategory);

        // Si está completado pero la categoría no refleja "Completed", esperar y reintentar
        if (appointmentStatus === 'C' && !appointmentCategory.includes('Completed')) {
          console.log('  - ⚠️  TIMING ISSUE: Status=Completed pero categoría no actualizada');
          console.log('  - 🔄 Esperando 15 segundos para que BridalLive actualice la categoría...');

          await new Promise(resolve => setTimeout(resolve, 15000));

          console.log('  - 🔄 Reintentando obtener categoría actualizada...');
          try {
            categoryDescription = await bridalLiveService.getCategoryDescription(result.data.raw.contact.categoryId);
            console.log('  - 📊 Categoría tras espera:', categoryDescription);

            // Si aún no está actualizada, usar lógica de mapping manual
            if (!categoryDescription.includes('Completed')) {
              categoryDescription = appointmentCategory.replace('Booked', 'Booked - Completed');
              console.log('  - 🔧 Categoría corregida manualmente:', categoryDescription);
            }
          } catch (error) {
            console.log('  - ⚠️  Error obteniendo categoría, usando mapping manual');
            categoryDescription = appointmentCategory.replace('Booked', 'Booked - Completed');
          }

          console.log('  - ✅ Categoría final tras corrección:', categoryDescription);
        } else {
          categoryDescription = appointmentCategory;
          console.log('  - ✅ Usando categoría del appointment (sin timing issues)');
        }
      }
      // Si no hay appointment o no tiene categoría, usar la del contacto
      else if (result.data.raw.contact && result.data.raw.contact.categoryId !== undefined) {
        try {
          categoryDescription = await bridalLiveService.getCategoryDescription(result.data.raw.contact.categoryId);
          console.log('  - Categoría ID del contacto:', result.data.raw.contact.categoryId);
          console.log('  - Categoría del contacto:', categoryDescription);
        } catch (error) {
          console.log('  - Categoría ID del contacto:', result.data.raw.contact.categoryId);
          console.log('  - Categoría: Error obteniendo descripción');
        }
      } else {
        console.log('  - Categoría ID: No disponible o es 0');
        console.log('  - Categoría: Unassigned');
      }

      // Sincronizar con Shopify
      console.log('\n🔍 VERIFICANDO DATOS PARA SHOPIFY...');
      console.log('   - Contact data:', !!result.data.contact);
      console.log('   - Contact email:', result.data.contact?.email);
      console.log('   - Employee data:', !!result.data.employee);
      console.log('   - Category description:', categoryDescription);
      
      if (result.data.contact && result.data.contact.email) {
        try {
          console.log('\n🛍️  SINCRONIZANDO CON SHOPIFY...');
          
          // Extraer appointments del webhook (si están disponibles)
          const appointments = [];
          if (result.data.raw.appointment) {
            appointments.push(`Appointment: ${JSON.stringify(result.data.raw.appointment)}`);
          }
          
          console.log('📊 Datos a sincronizar:');
          console.log('   - Contact:', result.data.contact);
          console.log('   - Employee:', result.data.employee);
          console.log('   - Category:', categoryDescription);
          console.log('   - Appointments:', appointments);
          
          const shopifyCustomer = await shopifyService.syncCustomer(
            result.data.contact,
            result.data.employee,
            categoryDescription,
            appointments
          );
          
          console.log('✅ Customer sincronizado con Shopify:', shopifyCustomer.id);
          console.log('   - Email:', shopifyCustomer.email);
          console.log('   - Nombre:', shopifyCustomer.first_name, shopifyCustomer.last_name);
          console.log('   - Tags:', shopifyCustomer.tags);
          console.log('   - Suscrito a marketing:', shopifyCustomer.email_marketing_consent?.state === 'subscribed' ? '✅ Sí' : '❌ No');
          console.log('   - Nivel de suscripción:', shopifyCustomer.email_marketing_consent?.opt_in_level);
          
        } catch (error) {
          console.error('❌ Error sincronizando con Shopify:', error.message);
          if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
          }
        }
      } else {
        console.log('\n⚠️  No se puede sincronizar con Shopify: Email no disponible');
        console.log('   - Contact data:', result.data.contact);
        console.log('   - Contact email:', result.data.contact?.email);
      }
    }
    
    // Mostrar datos del empleado
    if (result.data.employee) {
      console.log('\n👤 EMPLEADO:');
      console.log('  - ID:', result.data.employee.id);
      console.log('  - Nombre:', result.data.employee.firstName, result.data.employee.lastName);
      console.log('  - Username:', result.data.employee.username);
      console.log('  - Email:', result.data.employee.email);
      console.log('  - Retailer ID:', result.data.employee.retailerId);
      console.log('  - Rol:', result.data.employee.role);
    }
    
    // Mostrar flows
    if (result.data.flows && result.data.flows.length > 0) {
      console.log('\n🔄 FLOWS:');
      result.data.flows.forEach((flow, index) => {
        console.log(`  Flow ${index + 1}: ${flow.name} (ID: ${flow.id})`);
        if (flow.webhooks.length > 0) {
          flow.webhooks.forEach((webhook, webhookIndex) => {
            console.log(`    Webhook ${webhookIndex + 1}: ${webhook.endpointURL}`);
          });
        }
      });
    }
    
    console.log('\n--- DATOS VALIDADOS CON ZOD ---');
    console.log('Contacto válido:', !!result.data.contact);
    console.log('Empleado válido:', !!result.data.employee);
    console.log('Flows válidos:', result.data.flows?.length || 0);
    
  } else {
    console.log('\n❌ ERROR PROCESANDO WEBHOOK:');
    console.log('Error:', result.error);
    console.log('Body recibido:', result.rawBody);
  }
  
  console.log('========================');
  
  // Responder con éxito
  res.status(200).json({ 
    message: 'Webhook recibido correctamente',
    timestamp: new Date().toISOString(),
    processed: result.success
  });
});

app.post('/bridallive/webhook', async (req, res) => {
  try {
    console.log('===============================================');
    console.log('📥 SOLICITUD A /bridallive/webhook RECIBIDA');
    console.log('===============================================');
    console.log('🕐 Timestamp:', new Date().toISOString());
    console.log('🔗 Method:', req.method);
    console.log('🔗 URL:', req.url);
    console.log('🔗 Content-Type:', req.get('Content-Type'));
    console.log('🔗 Content-Length:', req.get('Content-Length'));
    console.log('🔗 User-Agent:', req.get('User-Agent'));

    console.log('\n📋 HEADERS COMPLETOS:');
    console.log(JSON.stringify(req.headers, null, 2));

    console.log('\n📦 BODY RAW (req.body):');
    console.log('Tipo de req.body:', typeof req.body);
    console.log('Es Array:', Array.isArray(req.body));
    console.log('Body completo:', JSON.stringify(req.body, null, 2));

    console.log('\n📦 QUERY PARAMETERS:');
    console.log('Query params:', JSON.stringify(req.query, null, 2));

    console.log('\n📦 FORM DATA (si existe):');
    if (req.body && typeof req.body === 'object') {
      Object.keys(req.body).forEach(key => {
        console.log(`  ${key}: ${req.body[key]} (tipo: ${typeof req.body[key]})`);
      });
    }

    // Verificar si es un evento de BridalLive (formulario embebido)
    if (req.body && req.body.type && req.body.type.startsWith('bridallive.')) {
      console.log('\n🌐 DETECTADO: Evento de BridalLive desde formulario embebido');
      console.log('📋 Tipo de evento:', req.body.type);
      console.log('📋 Value del evento:', req.body.value);

      // Parsear el value para obtener más información
      let eventData = {};
      try {
        if (req.body.value && typeof req.body.value === 'string') {
          eventData = JSON.parse(req.body.value);
          console.log('📋 Event data parseado:', eventData);
        }
      } catch (parseError) {
        console.log('⚠️  No se pudo parsear event data:', parseError.message);
      }

      // Para formularios embebidos de BridalLive, necesitamos obtener el contacto más reciente
      console.log('\n🔄 OBTENIENDO CONTACTO MÁS RECIENTE desde BridalLive API...');
    } else if (req.body && (req.body.email || req.body.firstName || req.body.first_name)) {
      console.log('\n🌐 DETECTADO: Datos directos del formulario web');
      console.log('📧 Email detectado:', req.body.email);
      console.log('👤 Nombre detectado:', req.body.firstName || req.body.first_name);
      console.log('👤 Apellido detectado:', req.body.lastName || req.body.last_name);

      // AQUÍ PROCESARÍAMOS DATOS DIRECTOS (si los tuviéramos)
      return res.status(200).json({
        success: true,
        message: 'Datos directos del formulario web recibidos',
        received_data: req.body,
        note: 'Procesamiento directo - implementación pendiente'
      });
    } else {
      console.log('\n🔄 MODO FALLBACK: Petición sin datos específicos');
    }

    // Asegurar login y obtener token
    const token = await bridalLiveService.getToken();
    
    // Obtener contactos recientes desde BridalLive (ordenados por fecha de creación)
    console.log('🔎 Consultando contactos recientes...');
    const axios = require('axios');
    const response = await axios.post('https://app.bridallive.com/bl-server/api/contacts/list', {
      typeId: 1,
      // Obtener varios contactos para encontrar el más reciente
      limit: 10
    }, {
      headers: {
        'token': token,
        'Content-Type': 'application/json'
      }
    });

    const contacts = response.data.result;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(404).json({ error: 'No se encontraron contactos en BridalLive' });
    }

    console.log(`📊 Se obtuvieron ${contacts.length} contactos de BridalLive`);

    // Filtrar contactos de las últimas 3 horas (para capturar el que acaba de completar el form)
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    let recentContacts = contacts.filter(contact =>
      contact.createdDate >= threeHoursAgo
    );

    console.log(`⏰ Contactos de las últimas 3 horas: ${recentContacts.length}`);

    // Si no hay contactos recientes, intentar con retry (BridalLive puede tardar en crear el contacto)
    if (recentContacts.length === 0) {
      console.log('\n🔄 RETRY: No hay contactos recientes, esperando 10 segundos y reintentando...');

      await new Promise(resolve => setTimeout(resolve, 10000)); // Esperar 10 segundos

      console.log('🔄 Segundo intento: Consultando contactos recientes...');
      const retryResponse = await axios.post('https://app.bridallive.com/bl-server/api/contacts/list', {
        typeId: 1,
        limit: 20 // Más contactos en el retry
      }, {
        headers: {
          'token': token,
          'Content-Type': 'application/json'
        }
      });

      const retryContacts = retryResponse.data.result;
      const retryRecentContacts = retryContacts.filter(contact =>
        contact.createdDate >= threeHoursAgo
      );

      console.log(`📊 Retry: Se obtuvieron ${retryContacts.length} contactos total`);
      console.log(`⏰ Retry: Contactos de las últimas 3 horas: ${retryRecentContacts.length}`);

      // Usar los contactos del retry si encontramos algunos recientes
      if (retryRecentContacts.length > 0) {
        recentContacts = retryRecentContacts;
        contacts = retryContacts; // Actualizar la lista completa también
        console.log('✅ Retry exitoso: Encontrados contactos recientes');
      } else {
        console.log('⚠️  Retry: Aún no hay contactos recientes, usando los originales');
      }
    }

    // Si no hay contactos recientes, usar todos
    const contactsToProcess = recentContacts.length > 0 ? recentContacts : contacts;

    // Ordenar por fecha de creación (más reciente primero)
    const sortedContacts = contactsToProcess.sort((a, b) => {
      return (b.createdDate || 0) - (a.createdDate || 0);
    });

    // Mostrar los primeros 5 contactos para referencia
    console.log('\n📋 Contactos candidatos (más recientes primero):');
    sortedContacts.slice(0, 5).forEach((contact, index) => {
      const date = new Date(contact.createdDate).toISOString();
      const minutesAgo = Math.round((Date.now() - contact.createdDate) / 1000 / 60);
      console.log(`   ${index + 1}. ${contact.firstName} ${contact.lastName} (${contact.emailAddress}) - ${date} (hace ${minutesAgo} min)`);
    });

    // Buscar específicamente marinmolinao13@gmail.com para debugging
    const specificContact = contacts.find(c => c.emailAddress === 'marinmolinao13@gmail.com');
    if (specificContact) {
      const minutesAgo = Math.round((Date.now() - specificContact.createdDate) / 1000 / 60);
      console.log('\n🔍 CONTACTO ESPECÍFICO ENCONTRADO (marinmolinao13@gmail.com):');
      console.log(`   Creado hace ${minutesAgo} minutos`);
      console.log(`   Fecha: ${new Date(specificContact.createdDate).toISOString()}`);
      console.log(`   ¿Está en los recientes (3h)? ${specificContact.createdDate >= threeHoursAgo ? 'SÍ' : 'NO'}`);
    }

    // Buscar posibles duplicados por teléfono en contactos recientes
    if (recentContacts.length > 0) {
      console.log('\n📱 ANÁLISIS DE TELÉFONOS EN CONTACTOS RECIENTES:');
      recentContacts.forEach((contact, index) => {
        const phone = contact.mobilePhoneNumber || contact.homePhoneNumber || contact.workPhoneNumber;
        console.log(`   ${index + 1}. ${contact.firstName} ${contact.lastName} - Tel: ${phone || 'Sin teléfono'}`);
      });
    }

    // Permitir override para testing - si especificamos un email en query params
    let contact;
    if (req.query.email) {
      console.log(`\n🧪 MODO TESTING: Buscando contacto específico: ${req.query.email}`);
      contact = contacts.find(c => c.emailAddress === req.query.email);
      if (!contact) {
        return res.status(404).json({
          error: `Contacto con email ${req.query.email} no encontrado para testing`
        });
      }
      console.log('✅ Contacto para testing encontrado');
    } else {
      // Seleccionar el contacto más reciente
      contact = sortedContacts[0];
    }

    console.log('\n👤 CONTACTO SELECCIONADO:', {
      id: contact.id,
      emailAddress: contact.emailAddress,
      firstName: contact.firstName,
      lastName: contact.lastName,
      createdDate: new Date(contact.createdDate).toISOString(),
      categoryId: contact.categoryId,
      categoryDescription: contact.categoryDescription,
      source: req.query.email ? 'TESTING_MODE' : 'AUTO_RECENT'
    });

    // Preparar datos de contacto en el mismo formato que /webhook
    const contactData = {
      email: contact.emailAddress || undefined,
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      phone: contact.mobilePhoneNumber || contact.homePhoneNumber || contact.workPhoneNumber || '',
      state: contact.state || '',
      country: contact.country || 'United States',
      externalId: contact.id,
      pin: contact.pin,
      createdDate: contact.createdDate,
      categoryId: contact.categoryId
    };

    // Obtener descripción de categoría (si no viene en el contacto)
    let categoryDescription = contact.categoryDescription;
    if (!categoryDescription) {
      categoryDescription = await bridalLiveService.getCategoryDescription(contact.categoryId);
    }

    // Agregar etiqueta especial para contactos del formulario web
    const webFormTag = 'Web Form Lead';
    const finalTags = categoryDescription ? [categoryDescription, webFormTag] : [webFormTag];

    console.log('🏷️  Tags finales para el customer:', finalTags);

    // No tenemos información de empleado ni citas en esta consulta
    const employeeData = null;
    const appointments = [];

    console.log('\n📝 DATOS PREPARADOS PARA SINCRONIZACIÓN:');
    console.log('   📧 Email:', contactData.email);
    console.log('   👤 Nombre completo:', `${contactData.firstName} ${contactData.lastName}`);
    console.log('   📱 Teléfono:', contactData.phone);
    console.log('   🏷️  Categoría original:', categoryDescription);
    console.log('   🏷️  Tags finales:', finalTags);

    // Sincronizar con Shopify usando la misma lógica que /webhook
    console.log('🛍️  Sincronizando contacto con Shopify...');

    // Combinar tags en una sola string para compatibilidad con syncCustomer
    const combinedTags = finalTags.join(', ');
    console.log('🏷️  Tags combinadas:', combinedTags);

    const shopifyCustomer = await shopifyService.syncCustomer(
      contactData,
      employeeData,
      combinedTags, // Usar tags combinadas
      appointments
    );

    console.log('✅ Customer sincronizado con Shopify:', shopifyCustomer.id);
    console.log('   - Email:', shopifyCustomer.email);
    console.log('   - Nombre:', shopifyCustomer.first_name, shopifyCustomer.last_name);
    console.log('   - Tags:', shopifyCustomer.tags);
    console.log('   - Suscrito a marketing:', shopifyCustomer.email_marketing_consent?.state === 'subscribed' ? '✅ Sí' : '❌ No');

    return res.status(200).json({
      success: true,
      message: 'Lead del formulario embebido sincronizado exitosamente',
      source: 'bridallive_embedded_form',
      event_type: req.body.type,
      customer: {
        id: shopifyCustomer.id,
        email: shopifyCustomer.email,
        first_name: shopifyCustomer.first_name,
        last_name: shopifyCustomer.last_name,
        tags: shopifyCustomer.tags,
        marketing_subscribed: shopifyCustomer.email_marketing_consent?.state === 'subscribed'
      },
      bridallive_contact: {
        id: contact.id,
        created_date: new Date(contact.createdDate).toISOString(),
        original_category: categoryDescription
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.log('\n===============================================');
    console.error('❌ ERROR EN /bridallive/webhook');
    console.log('===============================================');
    console.error('🕐 Timestamp:', new Date().toISOString());
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);

    if (error.response) {
      console.error('🌐 HTTP Response Status:', error.response.status);
      console.error('🌐 HTTP Response Headers:', JSON.stringify(error.response.headers, null, 2));
      console.error('🌐 HTTP Response Data:', JSON.stringify(error.response.data, null, 2));
    }

    console.error('📦 Request body que causó el error:', JSON.stringify(req.body, null, 2));
    console.log('===============================================\n');

    return res.status(500).json({
      error: 'Error procesando la solicitud en /bridallive/webhook',
      message: error.message,
      details: error.response?.data,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint GET para verificar que el servidor está funcionando
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

// Endpoint para probar la conexión con BridalLive
app.get('/test-bridallive', async (req, res) => {
  try {
    console.log('🧪 Probando conexión con BridalLive...');
    
    // Probar login
    const loginSuccess = await bridalLiveService.login();
    if (!loginSuccess) {
      return res.status(500).json({ error: 'Error en login de BridalLive' });
    }
    
    // Obtener categorías
    const categories = await bridalLiveService.getCategories();
    
    res.json({
      success: true,
      message: 'Conexión con BridalLive exitosa',
      categoriesCount: categories.length,
      sampleCategories: categories.slice(0, 5).map(cat => ({
        id: cat.id,
        description: cat.description
      }))
    });
  } catch (error) {
    console.error('❌ Error probando BridalLive:', error.message);
    res.status(500).json({ 
      error: 'Error probando BridalLive', 
      message: error.message 
    });
  }
});

// Endpoint para probar la conexión con Shopify
app.get('/test-shopify', async (req, res) => {
  try {
    console.log('🧪 Probando conexión con Shopify...');
    
    const shopInfo = await shopifyService.getShopInfo();
    
    res.json({
      success: true,
      message: 'Conexión con Shopify exitosa',
      shop: {
        id: shopInfo.id,
        name: shopInfo.name,
        domain: shopInfo.domain,
        email: shopInfo.email,
        currency: shopInfo.currency
      }
    });
  } catch (error) {
    console.error('❌ Error probando Shopify:', error.message);
    res.status(500).json({ 
      error: 'Error probando Shopify', 
      message: error.message 
    });
  }
});

// Endpoint para probar suscripción por email
app.post('/test-email-subscription', async (req, res) => {
  try {
    const { email, action = 'subscribe' } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email es requerido' });
    }

    console.log(`🧪 Probando ${action} para email: ${email}`);
    
    // Buscar customer
    const customer = await shopifyService.findCustomerByEmail(email);
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer no encontrado' });
    }

    let result;
    if (action === 'subscribe') {
      result = await shopifyService.subscribeCustomerToEmail(customer.id);
    } else if (action === 'unsubscribe') {
      result = await shopifyService.unsubscribeCustomerFromEmail(customer.id);
    } else {
      return res.status(400).json({ error: 'Acción inválida. Use "subscribe" o "unsubscribe"' });
    }

    res.json({
      success: true,
      message: `Customer ${action} exitoso`,
      customer: {
        id: result.id,
        email: result.email,
        email_marketing_consent: result.email_marketing_consent
      }
    });
  } catch (error) {
    console.error('❌ Error probando suscripción:', error.message);
    res.status(500).json({ 
      error: 'Error probando suscripción', 
      message: error.message 
    });
  }
});

// Endpoint para probar sincronización directa
app.post('/test-sync', async (req, res) => {
  try {
    const { email, firstName, lastName, phone } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email es requerido' });
    }

    console.log(`🧪 Probando sincronización directa para email: ${email}`);
    
    const contactData = {
      email: email,
      firstName: firstName || 'Test',
      lastName: lastName || 'Customer',
      phone: phone || '+13055551234',
      state: 'FL',
      country: 'United States',
      externalId: Date.now(),
      pin: '123456',
      createdDate: Date.now(),
      categoryId: 60210
    };

    const employeeData = {
      id: 83363,
      firstName: 'Daniela',
      lastName: 'Mesa',
      username: 'dmesa',
      retailerId: 'c7fde469'
    };

    const categoryDescription = 'Brides - Booked';
    const appointments = [];

    const result = await shopifyService.syncCustomer(
      contactData,
      employeeData,
      categoryDescription,
      appointments,
      true // subscribeToEmail
    );

    res.json({
      success: true,
      message: 'Sincronización exitosa',
      customer: {
        id: result.id,
        email: result.email,
        first_name: result.first_name,
        last_name: result.last_name,
        email_marketing_consent: result.email_marketing_consent,
        tags: result.tags
      }
    });
  } catch (error) {
    console.error('❌ Error probando sincronización:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    res.status(500).json({ 
      error: 'Error probando sincronización', 
      message: error.message,
      details: error.response?.data
    });
  }
});

// Endpoint para actualizar etiquetas de BridalLive
app.get('/update-bridallive-tags', async (req, res) => {
  try {
    console.log('📥 === ACTUALIZACIÓN DE ETIQUETAS BRIDALLIVE ===');
    console.log('Timestamp:', new Date().toISOString());
    
    // Login en BridalLive
    console.log('🔐 Iniciando sesión en BridalLive...');
    const loginSuccess = await bridalLiveService.login();
    
    if (!loginSuccess) {
      return res.status(500).json({ 
        error: 'Error en login de BridalLive',
        message: 'No se pudo autenticar con BridalLive'
      });
    }
    
    console.log('✅ Login exitoso en BridalLive');
    
    // Obtener token de BridalLive
    const token = await bridalLiveService.getToken();
    if (!token) {
      return res.status(500).json({ 
        error: 'Token no disponible',
        message: 'No se pudo obtener el token de BridalLive'
      });
    }
    
    console.log('🔑 Token obtenido:', token.substring(0, 10) + '...');
    
    // Configuración de todas las categorías de novias
    const bridesCategories = [
      { id: 53670, name: 'Brides - Booked - Completed', icon: '✅', testLimit: 1 },
      { id: 53671, name: 'Brides - Not Purchased', icon: '⚫', testLimit: 1 },
      { id: 53672, name: 'Brides - Purchased', icon: '✅', testLimit: 1 },
      { id: 55210, name: 'Brides - Accessories - Purchased', icon: '💍', testLimit: 1 },
      { id: 58522, name: 'Brides - Civil - Booked', icon: '📅', testLimit: 1 },
      { id: 58523, name: 'Brides - Civil - Purchased', icon: '✅', testLimit: 1 },
      { id: 58524, name: 'Brides - Civil - Not Purchased', icon: '⚫', testLimit: 1 },
      { id: 60210, name: 'Brides - Booked', icon: '📅', testLimit: 1 },
      { id: 65553, name: 'Brides - Booked - Canceled/No Show', icon: '❌', testLimit: 1 }
    ];

    // Consumir endpoint de contactos para todas las categorías de novias
    console.log(`📋 Obteniendo contactos de BridalLive para ${bridesCategories.length} categorías de novias...`);
    const axios = require('axios');

    const categoryResults = [];
    const allContacts = [];

    // Procesar cada categoría
    for (const category of bridesCategories) {
      try {
        console.log(`   🔍 Consultando categoría ${category.id}: "${category.name}" ${category.icon}`);

        const response = await axios.post('https://app.bridallive.com/bl-server/api/contacts/list', {
          typeId: 1,
          categoryId: category.id
        }, {
          headers: {
            'token': token,
            'Content-Type': 'application/json'
          }
        });

        const contacts = response.data.result;
        const contactCount = Array.isArray(contacts) ? contacts.length : 0;

        categoryResults.push({
          ...category,
          contacts: contacts || [],
          count: contactCount
        });

        if (Array.isArray(contacts)) {
          allContacts.push(...contacts);
        }

        console.log(`      ✅ ${contactCount} contactos encontrados`);
      } catch (error) {
        console.error(`      ❌ Error en categoría ${category.id}:`, error.message);
        categoryResults.push({
          ...category,
          contacts: [],
          count: 0,
          error: error.message
        });
      }
    }

    const totalContacts = allContacts.length;

    if (totalContacts === 0) {
      return res.status(500).json({
        error: 'No se pudieron obtener contactos de BridalLive',
        message: 'Todas las categorías devolvieron arrays vacíos o con errores',
        categories: categoryResults.map(cat => ({
          id: cat.id,
          name: cat.name,
          count: cat.count,
          error: cat.error || null
        }))
      });
    }
    
    console.log(`\n📊 Total de contactos obtenidos: ${totalContacts}`);

    // Mostrar resumen por categoría
    categoryResults.forEach(cat => {
      const status = cat.error ? '❌ ERROR' : `✅ ${cat.count}`;
      console.log(`   ${cat.icon} ${cat.name}: ${status}`);
      if (cat.error) {
        console.log(`      Error: ${cat.error}`);
      }
    });
    console.log('=====================================');

    // Preparar contactos para procesamiento en modo testing
    const contactsToProcess = [];
    const categoryStats = [];

    categoryResults.forEach(category => {
      if (category.count > 0) {
        const contactsFromCategory = category.contacts.slice(0, category.testLimit);
        contactsToProcess.push(...contactsFromCategory);

        categoryStats.push({
          id: category.id,
          name: category.name,
          icon: category.icon,
          total: category.count,
          processed: contactsFromCategory.length
        });

        console.log(`\n${category.icon} Categoría "${category.name}":`);
        console.log(`   - Total encontrados: ${category.count}`);
        console.log(`   - A procesar (testing): ${contactsFromCategory.length}`);
      }
    });

    console.log(`\n🧪 Modo testing - Total a procesar: ${contactsToProcess.length} contactos`);
    
    // Importar el servicio de Shopify
    const shopifyService = require('./shopify-service');
    
    let processedCount = 0;
    let updatedCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    const errors = [];
    
    // Procesar cada contacto
    for (const contact of contactsToProcess) {
      try {
        // Determinar la categoría del contacto y las etiquetas a aplicar
        const category = contact.categoryDescription;
        const categoryConfig = bridesCategories.find(cat => cat.name === category);
        const categoryIcon = categoryConfig ? categoryConfig.icon : '❓';
        const tagsToApply = [category];

        console.log(`\n🔍 Procesando contacto ${categoryIcon}: ${contact.firstName} ${contact.lastName} (${contact.emailAddress})`);
        console.log(`   🏷️ Categoría: "${category}"`);

        // Buscar el customer en Shopify por email
        const customer = await shopifyService.findCustomerByEmail(contact.emailAddress);

        if (customer) {
          console.log(`   ✅ Customer encontrado en Shopify: ID ${customer.id}`);

          // Actualizar las etiquetas del customer con la categoría correcta
          const updatedCustomer = await shopifyService.updateCustomerTags(customer.id, tagsToApply);

          if (updatedCustomer) {
            console.log(`   🏷️  Etiquetas actualizadas: ["${category}"]`);
            updatedCount++;
          } else {
            console.log(`   ❌ Error actualizando etiquetas`);
            errorCount++;
            errors.push(`Error actualizando etiquetas para ${contact.emailAddress}`);
          }
        } else {
          console.log(`   ⚠️  Customer no encontrado en Shopify`);
          notFoundCount++;
        }
        
        processedCount++;
        
      } catch (error) {
        console.error(`   ❌ Error procesando contacto ${contact.emailAddress}:`, error.message);
        errorCount++;
        errors.push(`Error procesando ${contact.emailAddress}: ${error.message}`);
      }
    }
    
    console.log('\n✅ Procesamiento completado');
    console.log('========================');
    console.log(`📊 Resumen:`);
    console.log(`   - Total contactos procesados: ${processedCount}`);
    console.log(`   - Customers actualizados: ${updatedCount}`);
    console.log(`   - Customers no encontrados: ${notFoundCount}`);
    console.log(`   - Errores: ${errorCount}`);
    
    // Devolver resumen del procesamiento
    const summary = {
      success: true,
      message: `Procesados ${processedCount} contactos de ${categoryStats.length} categorías de novias (modo testing)`,
      totalContacts: totalContacts,
      categoriesQueried: bridesCategories.length,
      categoriesWithContacts: categoryStats.length,
      categories: categoryStats.reduce((acc, cat) => {
        acc[cat.name.replace(/[^a-zA-Z0-9]/g, '')] = {
          id: cat.id,
          name: cat.name,
          icon: cat.icon,
          total: cat.total,
          processed: cat.processed
        };
        return acc;
      }, {}),
      processing: {
        processed: processedCount,
        updated: updatedCount,
        notFound: notFoundCount,
        errors: errorCount
      },
      errorDetails: errors.length > 0 ? errors : null,
      testingMode: true,
      timestamp: new Date().toISOString()
    };
    
    res.json(summary);
    
  } catch (error) {
    console.error('❌ Error obteniendo contactos de BridalLive:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    res.status(500).json({ 
      error: 'Error obteniendo contactos de BridalLive', 
      message: error.message,
      details: error.response?.data
    });
  }
});

// Endpoint de prueba para simular formulario web
app.post('/test-form-webhook', (req, res) => {
  console.log('🧪 TEST: Simulando envío de formulario a /bridallive/webhook');

  const testFormData = {
    email: 'test.form@example.com',
    firstName: 'Test',
    lastName: 'Form',
    phone: '+1234567890',
    state: 'FL',
    country: 'United States',
    source: 'web_form'
  };

  console.log('🧪 Enviando datos de prueba:', testFormData);

  // Hacer una petición interna al endpoint
  const axios = require('axios');
  const serverPort = config.server.port;

  axios.post(`http://localhost:${serverPort}/bridallive/webhook`, testFormData)
    .then(response => {
      console.log('✅ Prueba exitosa:', response.data);
      res.json({
        success: true,
        message: 'Prueba del formulario completada',
        test_data_sent: testFormData,
        endpoint_response: response.data
      });
    })
    .catch(error => {
      console.error('❌ Error en prueba:', error.message);
      res.status(500).json({
        error: 'Error en prueba del formulario',
        test_data_sent: testFormData,
        error_message: error.message
      });
    });
});

// Endpoint raíz
app.get('/', (req, res) => {
  res.json({
    message: 'Sync-Sayes Webhook Server',
    endpoints: {
      webhook: 'POST /webhook',
      bridalLiveWebhook: 'POST /bridallive/webhook',
      health: 'GET /health',
      testBridalLive: 'GET /test-bridallive',
      testShopify: 'GET /test-shopify',
      testEmailSubscription: 'POST /test-email-subscription',
      testSync: 'POST /test-sync',
      updateBridalLiveTags: 'GET /update-bridallive-tags',
      testFormWebhook: 'POST /test-form-webhook'
    }
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
  console.error('Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});
