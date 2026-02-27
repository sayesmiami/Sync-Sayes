const { z } = require('zod');

// Schema para el empleado logueado
const loggedInEmployeeSchema = z.object({
  id: z.number(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  emailAddress: z.string().email().nullable().optional(),
  retailerId: z.string().nullable().optional(),
  role: z.object({
    id: z.number(),
    description: z.string().nullable().optional(),
  }).nullable().optional(),
});

// Schema para el contacto
const contactSchema = z.object({
  id: z.number(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  emailAddress: z.string().email().nullable().optional(),
  mobilePhoneNumber: z.string().nullable().optional(),
  homePhoneNumber: z.string().nullable().optional(),
  workPhoneNumber: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  pin: z.string().nullable().optional(),
  createdDate: z.number(),
  address1: z.string().nullable().optional(),
  address2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  categoryId: z.number().nullable().optional(),
  howHeardId: z.number().nullable().optional(),
  preferredContactMethodId: z.number().nullable().optional(),
  employeeId: z.number().nullable().optional(),
  smsOptIn: z.boolean().nullable().optional(),
  event: z.object({
    id: z.number(),
    typeId: z.number().nullable().optional(),
    createdDate: z.number(),
  }).nullable().optional(),
});

// Schema para los flows
const flowItemSchema = z.object({
  id: z.number(),
  actionTypeDescription: z.string().optional(),
  endpointURL: z.string().url().nullable().optional(),
  endpointDescription: z.string().nullable().optional(),
  executionSucceeded: z.boolean().optional(),
});

const flowSchema = z.object({
  id: z.number(),
  name: z.string(),
  triggerId: z.number(),
  status: z.string(),
  items: z.array(flowItemSchema).optional(),
});

// Schema principal del webhook
const webhookDataSchema = z.object({
  loggedInEmployee: loggedInEmployeeSchema.optional(),
  contact: contactSchema.optional(),
  event: z.any().optional(),
  appointment: z.any().optional(),
  transaction: z.any().optional(),
  quote: z.any().optional(),
  purchaseOrder: z.any().optional(),
  receivingVoucher: z.any().optional(),
  flows: z.array(flowSchema).optional(),
});

// Schema para el formato del webhook (array con value)
const webhookFormatSchema = z.array(
  z.object({
    value: z.string().transform((str) => {
      try {
        return JSON.parse(str);
      } catch (error) {
        throw new Error('Invalid JSON in value field');
      }
    }).pipe(webhookDataSchema)
  })
);

// Schema simplificado para datos de contacto (tu schema original mejorado)
const contactDataSchema = z
  .object({
    email: z.string().email().optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    phone: z.string().optional(),
    externalId: z.union([z.string(), z.number()]).optional(),
  })
  .or(
    z.object({
      email: z.string().email().optional(),
      first_name: z.string().min(1).optional(),
      last_name: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
      phone: z.string().optional(),
      external_id: z.union([z.string(), z.number()]).optional(),
    })
  )
  .refine((data) => {
    // Al menos debe tener email, o firstName/lastName, o externalId
    const hasEmail = data.email || data.email;
    const hasName = (data.firstName || data.first_name) && (data.lastName || data.last_name);
    const hasExternalId = data.externalId || data.external_id;
    
    return hasEmail || hasName || hasExternalId;
  }, {
    message: "Must provide either email, or firstName+lastName, or externalId"
  });

// Función para extraer datos de contacto del webhook
function extractContactData(webhookData) {
  if (!webhookData.contact) {
    return null;
  }

  const contact = webhookData.contact;
  return {
    email: contact.emailAddress,
    firstName: contact.firstName,
    lastName: contact.lastName,
    state: contact.state,
    phone: contact.mobilePhoneNumber || contact.homePhoneNumber || contact.workPhoneNumber,
    externalId: contact.id,
    pin: contact.pin,
    country: contact.country,
    createdDate: contact.createdDate,
    categoryId: contact.categoryId,
    howHeardId: contact.howHeardId,
    preferredContactMethodId: contact.preferredContactMethodId,
    employeeId: contact.employeeId,
    smsOptIn: contact.smsOptIn,
  };
}

// Función para extraer datos del empleado
function extractEmployeeData(webhookData) {
  if (!webhookData.loggedInEmployee) {
    return null;
  }

  const employee = webhookData.loggedInEmployee;
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    username: employee.username,
    email: employee.emailAddress,
    retailerId: employee.retailerId,
    role: employee.role?.description,
  };
}

// Función para extraer información de flows
function extractFlowsData(webhookData) {
  if (!webhookData.flows || webhookData.flows.length === 0) {
    return [];
  }

  return webhookData.flows.map(flow => ({
    id: flow.id,
    name: flow.name,
    triggerId: flow.triggerId,
    status: flow.status,
    webhooks: flow.items?.filter(item => item.actionTypeDescription === 'System Action' && item.endpointURL) || [],
  }));
}

// Función principal para procesar el webhook
function processWebhookData(rawBody) {
  try {
    // Intentar parsear el body si viene como string
    let body = rawBody;
    if (typeof rawBody === 'string') {
      body = JSON.parse(rawBody);
    }

    let webhookData;

    // Verificar si es el formato array con value (formato original)
    if (Array.isArray(body) && body.length > 0 && body[0].value) {
      const validatedData = webhookFormatSchema.parse(body);
      webhookData = validatedData[0].value;
    }
    // Si es directamente el objeto del webhook (ya parseado por el middleware)
    else if (body.loggedInEmployee || body.contact || body.flows) {
      webhookData = webhookDataSchema.parse(body);
    }
    else {
      throw new Error('Formato de webhook no reconocido');
    }

    // Extraer datos estructurados
    const contactData = extractContactData(webhookData);
    const employeeData = extractEmployeeData(webhookData);
    const flowsData = extractFlowsData(webhookData);

    return {
      success: true,
      data: {
        contact: contactData,
        employee: employeeData,
        flows: flowsData,
        raw: webhookData,
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      rawBody: rawBody
    };
  }
}

module.exports = {
  webhookDataSchema,
  webhookFormatSchema,
  contactDataSchema,
  loggedInEmployeeSchema,
  contactSchema,
  flowSchema,
  extractContactData,
  extractEmployeeData,
  extractFlowsData,
  processWebhookData,
};
