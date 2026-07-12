import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/rejectProcessedSensor/rejectProcessedSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('RejectProcessedSensor Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
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
      expect(result.body).toBeUndefined();
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use default origin for disallowed origins', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin when no origin header is present', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        body: JSON.stringify({
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Successful batch deletion', () => {
    test('should successfully delete all sensor data items', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      
      const batchWriteCalls = docClientMock.calls();
      expect(batchWriteCalls.length).toBe(1);
      
      const batchWriteInput = batchWriteCalls[0].args[0].input;
      expect(batchWriteInput.TableName).toBe('test-temp-table');
      
      const requestItems = batchWriteInput.RequestItems['test-temp-table'];
      expect(requestItems).toHaveLength(8);
      
      const deleteKeys = requestItems.map(item => item.DeleteRequest.Key);
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'P12345#ABOUT' });
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'P12345#LIGANDS' });
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'P12345#LINEAGE' });
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'P12345#OPERATOR' });
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'P12345#OPERON' });
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'P12345#STRUCTURE' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: 'P12345' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: 'P12345#EDIT' });
    });

    test('should handle different family and ID combinations', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'KINASE',
          uniProtID: 'Q98765'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const batchWriteCalls = docClientMock.calls();
      const requestItems = batchWriteCalls[0].args[0].input.RequestItems['test-temp-table'];
      const deleteKeys = requestItems.map(item => item.DeleteRequest.Key);
      
      expect(deleteKeys).toContainEqual({ PK: 'KINASE', SK: 'Q98765#ABOUT' });
      expect(deleteKeys).toContainEqual({ PK: 'KINASE', SK: 'Q98765#LIGANDS' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: 'Q98765' });
    });

    test('should handle special characters in family and ID', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'FAMILY_WITH_UNDERSCORE',
          uniProtID: 'ID-WITH-DASHES_123'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const batchWriteCalls = docClientMock.calls();
      const requestItems = batchWriteCalls[0].args[0].input.RequestItems['test-temp-table'];
      const deleteKeys = requestItems.map(item => item.DeleteRequest.Key);
      
      expect(deleteKeys).toContainEqual({ PK: 'FAMILY_WITH_UNDERSCORE', SK: 'ID-WITH-DASHES_123#ABOUT' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: 'ID-WITH-DASHES_123' });
    });
  });

  describe('Request body parsing', () => {
    test('should parse JSON body correctly', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

      const requestBody = {
        family: 'ION_CHANNEL',
        uniProtID: 'X54321'
      };

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(requestBody)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const batchWriteCalls = docClientMock.calls();
      const requestItems = batchWriteCalls[0].args[0].input.RequestItems['test-temp-table'];
      const deleteKeys = requestItems.map(item => item.DeleteRequest.Key);
      
      expect(deleteKeys).toContainEqual({ PK: 'ION_CHANNEL', SK: 'X54321#ABOUT' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: 'X54321' });
    });

    test('should handle empty string values', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: '',
          uniProtID: ''
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const batchWriteCalls = docClientMock.calls();
      const requestItems = batchWriteCalls[0].args[0].input.RequestItems['test-temp-table'];
      const deleteKeys = requestItems.map(item => item.DeleteRequest.Key);
      
      expect(deleteKeys).toContainEqual({ PK: '', SK: '#ABOUT' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: '' });
    });

    test('should handle undefined family or uniProtID', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR'
          // Missing uniProtID
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const batchWriteCalls = docClientMock.calls();
      const requestItems = batchWriteCalls[0].args[0].input.RequestItems['test-temp-table'];
      const deleteKeys = requestItems.map(item => item.DeleteRequest.Key);
      
      expect(deleteKeys).toContainEqual({ PK: 'GPCR', SK: 'undefined#ABOUT' });
      expect(deleteKeys).toContainEqual({ PK: 'TEMP', SK: 'undefined' });
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB BatchWrite errors gracefully', async () => {
      const batchWriteError = new Error('BatchWrite failed');
      docClientMock.on(BatchWriteCommand).rejects(batchWriteError);

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });

    test('should handle AccessDeniedException', async () => {
      const accessDeniedError = new Error('AccessDeniedException');
      accessDeniedError.name = 'AccessDeniedException';
      docClientMock.on(BatchWriteCommand).rejects(accessDeniedError);

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });

    test('should handle ResourceNotFoundException', async () => {
      const resourceNotFoundError = new Error('ResourceNotFoundException');
      resourceNotFoundError.name = 'ResourceNotFoundException';
      docClientMock.on(BatchWriteCommand).rejects(resourceNotFoundError);

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });

    test('should handle ValidationException', async () => {
      const validationError = new Error('ValidationException');
      validationError.name = 'ValidationException';
      docClientMock.on(BatchWriteCommand).rejects(validationError);

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });

    test('should handle unexpected errors', async () => {
      docClientMock.on(BatchWriteCommand).rejects(new Error('Unexpected error'));

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table name from environment variable', async () => {
      process.env.TEMP_TABLE_NAME = 'production-temp-table';
      
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      await handler(event);

      const batchWriteCalls = docClientMock.calls();
      expect(batchWriteCalls[0].args[0].input.TableName).toBe('production-temp-table');
      expect(batchWriteCalls[0].args[0].input.RequestItems['production-temp-table']).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    test('should handle case-sensitive Origin header', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'GPCR',
          uniProtID: 'P12345'
        })
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should handle malformed JSON in request body', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: '{"family": "GPCR", "uniProtID": "P12345"'
      };

      await expect(handler(event)).rejects.toThrow();
    });

    test('should handle missing request body', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      await expect(handler(event)).rejects.toThrow();
    });

    test('should handle numeric family and uniProtID', async () => {
      docClientMock.on(BatchWriteCommand).rejects(new Error('DynamoDB type error'));

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
          family: 123,
          uniProtID: 456
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });

    test('should handle boolean values in request body', async () => {
      docClientMock.on(BatchWriteCommand).rejects(new Error('DynamoDB type error'));

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
          family: true,
          uniProtID: false
        })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error trying to do batchWrite');
    });
  });

  describe('Batch write structure validation', () => {
    test('should create correct batch write structure for all sensor components', async () => {
      docClientMock.on(BatchWriteCommand).resolves({});

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
          family: 'TEST_FAMILY',
          uniProtID: 'TEST_ID'
        })
      };

      await handler(event);

      const batchWriteCalls = docClientMock.calls();
      const batchWriteInput = batchWriteCalls[0].args[0].input;
      
      expect(batchWriteInput.TableName).toBe('test-temp-table');
      
      const requestItems = batchWriteInput.RequestItems['test-temp-table'];
      expect(requestItems).toHaveLength(8);
      
      requestItems.forEach(item => {
        expect(item).toHaveProperty('DeleteRequest');
        expect(item.DeleteRequest).toHaveProperty('Key');
        expect(item.DeleteRequest.Key).toHaveProperty('PK');
        expect(item.DeleteRequest.Key).toHaveProperty('SK');
      });
      
      const expectedDeletes = [
        { PK: 'TEST_FAMILY', SK: 'TEST_ID#ABOUT' },
        { PK: 'TEST_FAMILY', SK: 'TEST_ID#LIGANDS' },
        { PK: 'TEST_FAMILY', SK: 'TEST_ID#LINEAGE' },
        { PK: 'TEST_FAMILY', SK: 'TEST_ID#OPERATOR' },
        { PK: 'TEST_FAMILY', SK: 'TEST_ID#OPERON' },
        { PK: 'TEST_FAMILY', SK: 'TEST_ID#STRUCTURE' },
        { PK: 'TEMP', SK: 'TEST_ID' },
        { PK: 'TEMP', SK: 'TEST_ID#EDIT' }
      ];
      
      const actualDeletes = requestItems.map(item => item.DeleteRequest.Key);
      expectedDeletes.forEach(expected => {
        expect(actualDeletes).toContainEqual(expected);
      });
    });
  });
});
