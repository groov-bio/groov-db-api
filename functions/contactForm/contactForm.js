import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import Joi from 'joi';
import fetch from 'node-fetch';

const contactSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  message: Joi.string().required(),
  turnstileToken: Joi.string().required(),
});

// List of allowed origins
const allowedOrigins = [
  'http://localhost:3000',
  'https://groov.bio',
  'https://www.groov.bio',
  'https://ligify.groov.bio',
  'https://www.ligify.groov.bio'
];

// Function to get CORS headers based on the request origin
const getCorsHeaders = (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:3000';
  
  // Check if the origin is in our allowed list
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:3000';
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
};

export const handler = async(event) => {
  console.log('Request event:', JSON.stringify(event, null, 2));
  
  // Get CORS headers for this specific request
  const corsHeaders = getCorsHeaders(event);
  
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: ''
    };
  }
  
  const sesClient = new SESClient({
    region: "us-east-2", 
  });

  // fetch form information
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  try {
    await contactSchema.validateAsync(body);
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid form data' })
    };
  }

  // Validate Turnstile token
  try {
    const turnstileResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: body.turnstileToken,
      }),
    });

    const turnstileData = await turnstileResponse.json();
    
    if (!turnstileData.success) {
      console.error('Turnstile validation failed:', turnstileData);
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'CAPTCHA validation failed' })
      };
    }
  } catch (err) {
    console.error('Error validating Turnstile token:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Error validating CAPTCHA' })
    };
  }

  const { name, email, message } = body;

  // Email parameters
  const params = {
    Source: process.env.FROM_EMAIL,
    Destination: {
      ToAddresses: [process.env.SEND_TO_EMAIL],
    },
    Message: {
      Subject: {
        Data: "New groovDB Contact submission",
        Charset: "UTF-8",
      },
      Body: {
        Text: {
          Data: `New contact form submission:
            Name: ${name}
            Email: ${email}
            Message: ${message}`
        },
      },
    },
  };

  try {
    // Send the email using the SendEmailCommand
    const data = await sesClient.send(new SendEmailCommand(params));
    console.log("Email sent successfully!", data);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Email sent successfully!",
        data: data,
      }),
    };
  } catch (err) {
    console.error("Error sending email:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Error sending email",
        error: err,
      }),
    };
  }
};
