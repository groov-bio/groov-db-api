import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const mockFetch = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch
}));

const sesClientMock = mockClient(SESClient);

const { handler } = await import('../../functions/contactForm/contactForm.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('ContactForm Function', () => {
  beforeEach(() => {
    sesClientMock.reset();
    mockFetch.mockReset();
    process.env.FROM_EMAIL = 'noreply@groov.bio';
    process.env.SEND_TO_EMAIL = 'contact@groov.bio';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'OPTIONS'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.headers['Access-Control-Allow-Methods']).toBe('POST,OPTIONS');
      expect(result.body).toBe('');
    });

    test('should use allowed origin for groov.bio', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://www.groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use default origin for disallowed origins', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin when no origin header is present', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Request body validation', () => {
    test('should return error for invalid JSON', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: 'invalid json'
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Invalid JSON');
    });

    test('should return error for missing required fields', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Invalid form data');
    });

    test('should return error for invalid email format', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'invalid-email',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Invalid form data');
    });

    test('should accept valid form data', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });
  });

  describe('Turnstile validation', () => {
    test('should successfully validate Turnstile token', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            secret: 'test-secret-key',
            response: 'valid-token',
          }),
        }
      );
      expect(result.statusCode).toBe(200);
    });

    test('should return error for failed Turnstile validation', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: false, 'error-codes': ['invalid-input-response'] })
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'invalid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('CAPTCHA validation failed');
    });

    test('should handle Turnstile API errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Error validating CAPTCHA');
    });
  });

  describe('Email sending functionality', () => {
    test('should send email successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      const mockSESResponse = { MessageId: 'test-message-id-123' };
      sesClientMock.on(SendEmailCommand).resolves(mockSESResponse);

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'This is a test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Email sent successfully!');
      expect(body.data).toEqual(mockSESResponse);

      const sesCalls = sesClientMock.calls();
      expect(sesCalls.length).toBe(1);
      const sesCallInput = sesCalls[0].args[0].input;
      expect(sesCallInput.Source).toBe('noreply@groov.bio');
      expect(sesCallInput.Destination.ToAddresses).toEqual(['contact@groov.bio']);
      expect(sesCallInput.Message.Subject.Data).toBe('New groovDB Contact submission');
      expect(sesCallInput.Message.Body.Text.Data).toContain('John Doe');
      expect(sesCallInput.Message.Body.Text.Data).toContain('john@example.com');
      expect(sesCallInput.Message.Body.Text.Data).toContain('This is a test message');
    });

    test('should handle SES errors', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).rejects(new Error('SES sending failed'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error sending email');
      expect(body.error).toBeDefined();
    });

    test('should handle MessageRejected error', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      const messageRejectedError = new Error('MessageRejected');
      messageRejectedError.name = 'MessageRejected';
      sesClientMock.on(SendEmailCommand).rejects(messageRejectedError);

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error sending email');
    });
  });

  describe('Environment configuration', () => {
    test('should use correct environment variables', async () => {
      process.env.FROM_EMAIL = 'custom-from@test.com';
      process.env.SEND_TO_EMAIL = 'custom-to@test.com';
      process.env.TURNSTILE_SECRET_KEY = 'custom-secret';

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      await handler(event);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        expect.objectContaining({
          body: JSON.stringify({
            secret: 'custom-secret',
            response: 'valid-token',
          }),
        })
      );

      const sesCalls = sesClientMock.calls();
      const sesCallInput = sesCalls[0].args[0].input;
      expect(sesCallInput.Source).toBe('custom-from@test.com');
      expect(sesCallInput.Destination.ToAddresses).toEqual(['custom-to@test.com']);
    });
  });

  describe('Edge cases', () => {
    test('should handle case-sensitive Origin header', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          Origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should handle empty request body', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: ''
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Invalid JSON');
    });

    test('should handle null request body', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: null
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Invalid form data');
    });

    test('should handle malformed event object', async () => {
      const event = {
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          turnstileToken: 'valid-token'
        })
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should handle special characters in form data', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'José María García-López',
          email: 'josé@example.com',
          message: 'Special chars: àáâãäåæçèéêë & <script>alert("xss")</script>',
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const sesCalls = sesClientMock.calls();
      const emailBody = sesCalls[0].args[0].input.Message.Body.Text.Data;
      expect(emailBody).toContain('José María García-López');
      expect(emailBody).toContain('josé@example.com');
      expect(emailBody).toContain('Special chars: àáâãäåæçèéêë & <script>alert("xss")</script>');
    });

    test('should handle very long message content', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true })
      });

      sesClientMock.on(SendEmailCommand).resolves({
        MessageId: 'test-message-id'
      });

      const longMessage = 'A'.repeat(10000);

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify({
          name: 'John Doe',
          email: 'john@example.com',
          message: longMessage,
          turnstileToken: 'valid-token'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const sesCalls = sesClientMock.calls();
      const emailBody = sesCalls[0].args[0].input.Message.Body.Text.Data;
      expect(emailBody).toContain(longMessage);
    });
  });
});
