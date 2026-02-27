const axios = require('axios');
const config = require('./config');

class ShopifyService {
  constructor() {
    this.shopDomain = config.shopify.shopDomain;
    this.accessToken = config.shopify.accessToken;
    this.apiVersion = config.shopify.apiVersion;
    this.baseURL = `https://${this.shopDomain}/admin/api/${this.apiVersion}`;
  }

  // Headers para las peticiones a Shopify
  getHeaders() {
    return {
      'X-Shopify-Access-Token': this.accessToken,
      'Content-Type': 'application/json',
    };
  }

  // Buscar customer por email
  async findCustomerByEmail(email) {
    try {
      console.log(`🔍 Buscando customer en Shopify con email: ${email}`);
      console.log(`🔗 URL: ${this.baseURL}/customers.json`);
      
      // Primero intentar búsqueda por email
      let response = await axios.get(`${this.baseURL}/customers.json`, {
        headers: this.getHeaders(),
        params: {
          email: email,
          limit: 1
        }
      });

      console.log(`📊 Respuesta de Shopify (por email):`, response.data);
      let customers = response.data.customers;
      
      // Si no se encuentra por email, buscar en todos los clientes
      if (!customers || customers.length === 0) {
        console.log('🔍 No encontrado por email, buscando en todos los clientes...');
        response = await axios.get(`${this.baseURL}/customers.json`, {
          headers: this.getHeaders(),
          params: {
            limit: 250 // Máximo permitido por Shopify
          }
        });
        
        customers = response.data.customers.filter(customer => 
          customer.email && customer.email.toLowerCase() === email.toLowerCase()
        );
        
        console.log(`📊 Clientes encontrados por búsqueda manual: ${customers.length}`);
      }
      
      if (customers && customers.length > 0) {
        console.log(`✅ Customer encontrado: ${customers[0].id}`);
        console.log(`   - Email: ${customers[0].email}`);
        console.log(`   - Nombre: ${customers[0].first_name} ${customers[0].last_name}`);
        console.log(`   - Suscrito: ${customers[0].email_marketing_consent?.state === 'subscribed' ? 'Sí' : 'No'}`);
        return customers[0];
      } else {
        console.log('❌ Customer no encontrado');
        return null;
      }
    } catch (error) {
      console.error('❌ Error buscando customer en Shopify:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      throw error;
    }
  }

  // Crear nuevo customer
  async createCustomer(customerData) {
    try {
      console.log('🆕 Creando nuevo customer en Shopify...');
      
      const response = await axios.post(`${this.baseURL}/customers.json`, {
        customer: customerData
      }, {
        headers: this.getHeaders()
      });

      console.log(`✅ Customer creado: ${response.data.customer.id}`);
      return response.data.customer;
    } catch (error) {
      console.error('❌ Error creando customer en Shopify:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      throw error;
    }
  }

  // Actualizar customer existente
  async updateCustomer(customerId, customerData) {
    try {
      console.log(`🔄 Actualizando customer ${customerId} en Shopify...`);
      
      const response = await axios.put(`${this.baseURL}/customers/${customerId}.json`, {
        customer: customerData
      }, {
        headers: this.getHeaders()
      });

      console.log(`✅ Customer actualizado: ${customerId}`);
      return response.data.customer;
    } catch (error) {
      console.error('❌ Error actualizando customer en Shopify:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      throw error;
    }
  }

  // Preparar datos del customer para Shopify
  prepareCustomerData(contactData, employeeData, categoryDescription, appointments = [], subscribeToEmail = true) {
    // Preparar tags basicas
    const basicTags = [];
    if (categoryDescription) {
      basicTags.push(categoryDescription);
    }

    const customerData = {
      first_name: contactData.firstName || '',
      last_name: contactData.lastName || '',
      email: contactData.email || '',
      phone: contactData.phone || '',
      state: contactData.state || '',
      country: contactData.country || 'United States',
      tags: basicTags,
      note: this.formatCustomerNote(contactData, employeeData, appointments),
      email_marketing_consent: {
        state: subscribeToEmail ? 'subscribed' : 'not_subscribed',
        opt_in_level: 'single_opt_in',
        consent_updated_at: new Date().toISOString()
      }
    };

    return customerData;
  }

  // Formatear nota del customer
  formatCustomerNote(contactData, employeeData, appointments = []) {
    let note = `BridalLive ID: ${contactData.externalId}\n`;
    note += `Creado: ${new Date(contactData.createdDate).toLocaleString()}\n`;

    if (appointments && appointments.length > 0) {
      note += `\nAppointments:\n`;
      appointments.forEach((appointment, index) => {
        note += `${index + 1}. ${appointment}\n`;
      });
    }

    return note;
  }

  // Sincronizar customer (crear o actualizar)
  async syncCustomer(contactData, employeeData, categoryDescription, appointments = [], subscribeToEmail = true) {
    let existingCustomer = null;

    try {
      if (!contactData.email) {
        throw new Error('Email es requerido para sincronizar con Shopify');
      }

      console.log(`📧 Configuración de suscripción: ${subscribeToEmail ? 'SUSCRIBIR' : 'NO SUSCRIBIR'}`);

      // Buscar customer existente
      existingCustomer = await this.findCustomerByEmail(contactData.email);

      const customerData = this.prepareCustomerData(contactData, employeeData, categoryDescription, appointments, subscribeToEmail);

      // Si existe customer, manejar tags inteligentemente
      if (existingCustomer && existingCustomer.tags) {
        console.log('🏷️  Tags existentes en Shopify:', existingCustomer.tags);

        // Convertir tags existentes a array
        const existingTags = existingCustomer.tags.split(',').map(tag => tag.trim()).filter(tag => tag);
        console.log('🏷️  Tags existentes (array):', existingTags);

        // Convertir nuevas tags a array
        const newTags = Array.isArray(customerData.tags) ? customerData.tags : [categoryDescription].filter(Boolean);
        console.log('🏷️  Nuevas tags:', newTags);

        // Definir patrones de tags que deben reemplazarse (no acumularse)
        const bridesStatusPatterns = [
          'Brides - Consultation',
          'Brides - Booked',
          'Brides - Booked - Completed',
          'Brides - Not Purchased',
          'Unassigned'
        ];

        // Filtrar tags existentes: remover las que serán reemplazadas por el nuevo status
        const tagsToKeep = existingTags.filter(existingTag => {
          // Si la nueva tag es un status de brides, remover status anteriores
          if (newTags.some(newTag => bridesStatusPatterns.includes(newTag))) {
            return !bridesStatusPatterns.includes(existingTag);
          }
          return true;
        });

        console.log('🏷️  Tags a mantener (sin status obsoleto):', tagsToKeep);

        // Combinar tags mantenidas + nuevas tags
        const combinedTags = [...new Set([...tagsToKeep, ...newTags])];
        console.log('🏷️  Tags finales (con reemplazo inteligente):', combinedTags);

        // Actualizar customerData con tags combinadas
        customerData.tags = combinedTags;
      }

      console.log('📊 Datos del customer preparados:');
      console.log('   - email_marketing_consent.state:', customerData.email_marketing_consent.state);
      console.log('   - email_marketing_consent.opt_in_level:', customerData.email_marketing_consent.opt_in_level);
      console.log('   - tags finales:', customerData.tags);

      if (existingCustomer) {
        // Actualizar customer existente
        console.log('🔄 Customer existe, actualizando...');
        console.log(`   - ID existente: ${existingCustomer.id}`);
        console.log(`   - Estado actual de suscripción: ${existingCustomer.email_marketing_consent?.state === 'subscribed' ? 'SUSCRITO' : 'NO SUSCRITO'}`);

        if (subscribeToEmail) {
          console.log('📧 Suscribiendo customer a marketing por email');
        }
        return await this.updateCustomer(existingCustomer.id, customerData);
      } else {
        // Crear nuevo customer
        console.log('🆕 Customer no existe, creando...');
        if (subscribeToEmail) {
          console.log('📧 Suscribiendo nuevo customer a marketing por email');
        }
        return await this.createCustomer(customerData);
      }
    } catch (error) {
      // Si falla por validación de teléfono, intentar sin teléfono
      if (error.response && error.response.status === 422) {
        console.log('⚠️  Error de validación, intentando sin teléfono...');
        
        const customerDataWithoutPhone = this.prepareCustomerData(contactData, employeeData, categoryDescription, appointments, subscribeToEmail);
        delete customerDataWithoutPhone.phone;
        
        // Agregar teléfono a las notas
        customerDataWithoutPhone.note += `\nTeléfono: ${contactData.phone || 'No disponible'}`;

        try {
          if (existingCustomer) {
            return await this.updateCustomer(existingCustomer.id, customerDataWithoutPhone);
          } else {
            return await this.createCustomer(customerDataWithoutPhone);
          }
        } catch (retryError) {
          console.error('❌ Error en segundo intento:', retryError.message);
          throw retryError;
        }
      }
      
      throw error;
    }
  }

  // Suscribir customer a marketing por email
  async subscribeCustomerToEmail(customerId) {
    try {
      console.log(`📧 Suscribiendo customer ${customerId} a marketing por email...`);
      
      const response = await axios.put(`${this.baseURL}/customers/${customerId}.json`, {
        customer: {
          id: customerId,
          email_marketing_consent: {
            state: 'subscribed',
            opt_in_level: 'single_opt_in',
            consent_updated_at: new Date().toISOString()
          }
        }
      }, {
        headers: this.getHeaders()
      });

      console.log(`✅ Customer ${customerId} suscrito a marketing por email`);
      return response.data.customer;
    } catch (error) {
      console.error('❌ Error suscribiendo customer a marketing:', error.message);
      throw error;
    }
  }

  // Desuscribir customer de marketing por email
  async unsubscribeCustomerFromEmail(customerId) {
    try {
      console.log(`📧 Desuscribiendo customer ${customerId} de marketing por email...`);
      
      const response = await axios.put(`${this.baseURL}/customers/${customerId}.json`, {
        customer: {
          id: customerId,
          email_marketing_consent: {
            state: 'not_subscribed',
            opt_in_level: 'single_opt_in',
            consent_updated_at: new Date().toISOString()
          }
        }
      }, {
        headers: this.getHeaders()
      });

      console.log(`✅ Customer ${customerId} desuscrito de marketing por email`);
      return response.data.customer;
    } catch (error) {
      console.error('❌ Error desuscribiendo customer de marketing:', error.message);
      throw error;
    }
  }

  // Obtener información de la tienda
  async getShopInfo() {
    try {
      const response = await axios.get(`${this.baseURL}/shop.json`, {
        headers: this.getHeaders()
      });

      return response.data.shop;
    } catch (error) {
      console.error('❌ Error obteniendo información de la tienda:', error.message);
      throw error;
    }
  }

  /**
   * Actualiza las etiquetas de un customer en Shopify
   * @param {string} customerId - ID del customer en Shopify
   * @param {string[]} tags - Array de etiquetas a asignar
   * @returns {Object|null} - Customer actualizado o null si hay error
   */
  async updateCustomerTags(customerId, tags) {
    try {
      console.log(`🏷️  Actualizando etiquetas para customer ${customerId}:`, tags);
      
      const response = await axios.put(
        `https://${this.shopDomain}/admin/api/${this.apiVersion}/customers/${customerId}.json`,
        {
          customer: {
            id: customerId,
            tags: tags.join(', ')
          }
        },
        {
          headers: {
            'X-Shopify-Access-Token': this.accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Etiquetas actualizadas exitosamente para customer ${customerId}`);
      return response.data.customer;
    } catch (error) {
      console.error(`❌ Error actualizando etiquetas para customer ${customerId}:`, error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      return null;
    }
  }
}

// Crear instancia singleton
const shopifyService = new ShopifyService();

module.exports = shopifyService;
