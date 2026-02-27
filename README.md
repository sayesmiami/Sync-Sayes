# Sync-Sayes Webhook Server

Sistema de sincronización entre BridalLive y Shopify que procesa webhooks y sincroniza datos de clientes.

## 🚀 Funcionalidades

- **Webhook Processing**: Recibe y procesa webhooks de BridalLive
- **BridalLive Integration**: Consulta categorías automáticamente
- **Shopify Integration**: Sincroniza clientes con Shopify
- **Data Validation**: Validación robusta con Zod
- **Error Handling**: Manejo inteligente de errores de validación

## 📋 Configuración

### Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto:

```bash
# Shopify Configuration
SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com
SHOPIFY_ACCESS_TOKEN=your-access-token

# Server Configuration
PORT=3000
```

### Configuración de Shopify

1. **Crear una App Privada en Shopify**:
   - Ve a tu admin de Shopify
   - Apps > Develop apps > Create an app
   - Configura los permisos necesarios:
     - `read_customers`
     - `write_customers`

2. **Obtener Access Token**:
   - Instala la app en tu tienda
   - Copia el Access Token

## 🛠️ Instalación

```bash
# Instalar dependencias
npm install

# Ejecutar en desarrollo
npm run dev

# Ejecutar en producción
npm start
```

## 📡 Endpoints

- `POST /webhook` - Recibe webhooks de BridalLive
- `GET /health` - Estado del servidor
- `GET /test-bridallive` - Prueba conexión con BridalLive
- `GET /test-shopify` - Prueba conexión con Shopify
- `GET /` - Información de endpoints

## 🔄 Flujo de Sincronización

1. **Webhook recibido** de BridalLive
2. **Validación** de datos con Zod
3. **Consulta de categoría** en BridalLive API
4. **Búsqueda de cliente** en Shopify por email
5. **Sincronización**:
   - Si existe: Actualiza datos y notas
   - Si no existe: Crea nuevo cliente
6. **Manejo de errores**: Si falla por teléfono, reintenta sin teléfono

## 📊 Datos Sincronizados

### Información del Cliente
- Nombre y apellido
- Email
- Teléfono (con fallback a notas)
- Estado y país
- Categoría como tag

### Notas del Cliente
- ID de BridalLive
- PIN
- Fecha de creación
- Información del empleado
- Appointments (si están disponibles)

## 🚨 Manejo de Errores

- **Validación de teléfono**: Si Shopify rechaza el teléfono, se reintenta sin teléfono y se agrega a las notas
- **Email requerido**: Si no hay email, se omite la sincronización
- **Categoría no encontrada**: Se usa "Unassigned" como fallback

## 🧪 Pruebas

```bash
# Probar conexión con BridalLive
curl http://localhost:3000/test-bridallive

# Probar conexión con Shopify
curl http://localhost:3000/test-shopify

# Probar webhook
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: text/plain" \
  -d '[{"value": "{\"contact\":{\"id\":123,\"firstName\":\"Test\",\"lastName\":\"User\",\"emailAddress\":\"test@example.com\",\"categoryId\":55210}}"}]'
```

## 📝 Logs

El sistema genera logs detallados para:
- Procesamiento de webhooks
- Consultas a APIs
- Sincronización con Shopify
- Errores y fallbacks
