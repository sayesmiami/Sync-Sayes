const axios = require('axios');

class BridalLiveService {
  constructor() {
    this.baseURL = 'https://app.bridallive.com/bl-server/api';
    this.token = null;
    this.tokenExpires = null;
    this.categories = null;
    this.categoriesLastFetched = null;
  }

  // Hacer login y obtener token
  async login() {
    try {
      console.log('🔐 Iniciando sesión en BridalLive...');
      
      const response = await axios.post(`${this.baseURL}/auth/apiLogin`, {
        retailerId: "c7fde469",
        apiKey: "149b4cc037a04142"
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      this.token = response.data.token;
      this.tokenExpires = new Date(response.data.expires);
      
      console.log('✅ Login exitoso en BridalLive');
      console.log(`   Token expira: ${this.tokenExpires.toISOString()}`);
      
      return true;
    } catch (error) {
      console.error('❌ Error en login de BridalLive:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      return false;
    }
  }

  // Verificar si el token es válido
  isTokenValid() {
    if (!this.token || !this.tokenExpires) {
      return false;
    }
    
    // Verificar si el token expira en los próximos 5 minutos
    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
    
    return this.tokenExpires > fiveMinutesFromNow;
  }

  // Obtener categorías
  async getCategories() {
    try {
      // Si ya tenemos las categorías y son recientes (menos de 1 hora), usarlas
      if (this.categories && this.categoriesLastFetched) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (this.categoriesLastFetched > oneHourAgo) {
          console.log('📋 Usando categorías en caché');
          return this.categories;
        }
      }

      // Verificar si necesitamos hacer login
      if (!this.isTokenValid()) {
        const loginSuccess = await this.login();
        if (!loginSuccess) {
          throw new Error('No se pudo hacer login en BridalLive');
        }
      }

      console.log('📋 Obteniendo categorías de BridalLive...');
      
      const response = await axios.post(`${this.baseURL}/categories/list`, {}, {
        headers: {
          'Content-Type': 'application/json',
          'token': this.token
        }
      });

      this.categories = response.data;
      this.categoriesLastFetched = new Date();
      
      console.log(`✅ Se obtuvieron ${this.categories.length} categorías`);
      
      return this.categories;
    } catch (error) {
      console.error('❌ Error obteniendo categorías:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      throw error;
    }
  }

  // Obtener descripción de categoría por ID
  async getCategoryDescription(categoryId) {
    try {
      // Si categoryId es 0 o null, retornar "Unassigned"
      if (!categoryId || categoryId === 0) {
        return "Unassigned";
      }

      const categories = await this.getCategories();
      
      const category = categories.find(cat => cat.id === categoryId);
      
      if (category) {
        return category.description;
      } else {
        console.warn(`⚠️  Categoría con ID ${categoryId} no encontrada`);
        return `Categoría desconocida (ID: ${categoryId})`;
      }
    } catch (error) {
      console.error('❌ Error obteniendo descripción de categoría:', error.message);
      return `Error obteniendo categoría (ID: ${categoryId})`;
    }
  }

  // Obtener todas las categorías con sus IDs y descripciones
  async getAllCategoriesWithDescriptions() {
    try {
      const categories = await this.getCategories();
      
      return categories.map(cat => ({
        id: cat.id,
        description: cat.description,
        status: cat.status
      }));
    } catch (error) {
      console.error('❌ Error obteniendo todas las categorías:', error.message);
      return [];
    }
  }

  // Obtener el token actual
  async getToken() {
    if (!this.token || !this.tokenExpires || new Date() >= this.tokenExpires) {
      const loggedIn = await this.login();
      if (!loggedIn) {
        throw new Error('No se pudo obtener el token de autenticación para BridalLive.');
      }
    }
    return this.token;
  }
}

// Crear instancia singleton
const bridalLiveService = new BridalLiveService();

module.exports = bridalLiveService;
