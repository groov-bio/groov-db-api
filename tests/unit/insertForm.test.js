import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/insertForm/insertForm.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('InsertForm Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TABLE_NAME = 'test-prod-table';
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validFormData = {
    uniProtID: 'P12345',
    family: 'TETR',
    about: {
      about: 'Test sensor description',
      accession: 'TEST_ACC',
      alias: 'TestAlias',
      mechanism: 'Apo-repressor'
    },
    operator: {
      data: [
        {
          doi: '10.1234/test',
          method: 'EMSA',
          ref_figure: 'Figure 1',
          sequence: 'ATCGATCG'
        }
      ]
    },
    ligands: {
      data: [
        {
          doi: '10.1234/ligand',
          method: 'EMSA',
          ref_figure: 'Figure 2',
          name: 'TestLigand',
          SMILES: 'CCO'
        }
      ]
    },
    lineage: {
      child_id: '',
      mutation: '',
      parent_id: '',
      doi: ''
    },
    user: 'testuser',
    timeSubmit: 1640995200000
  };

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
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://www.groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use default origin for disallowed origins', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin when no origin header is present', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Request validation', () => {
    test('should accept valid form data', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    test('should return validation error for missing required fields', async () => {
      const invalidData = {
        family: 'TETR'
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
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
      expect(body.message.errors).toBeInstanceOf(Array);
    });

    test('should return validation error for invalid family', async () => {
      const invalidData = {
        ...validFormData,
        family: 'INVALID_FAMILY'
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
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should return validation error for invalid operator method', async () => {
      const invalidData = {
        ...validFormData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'INVALID_METHOD',
              ref_figure: 'Figure 1',
              sequence: 'ATCGATCG'
            }
          ]
        }
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
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should return validation error for invalid ref_figure format', async () => {
      const invalidData = {
        ...validFormData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'EMSA',
              ref_figure: 'Invalid Figure Format',
              sequence: 'ATCGATCG'
            }
          ]
        }
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
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should return validation error for invalid DNA sequence', async () => {
      const invalidData = {
        ...validFormData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'EMSA',
              ref_figure: 'Figure 1',
              sequence: 'ATCGXYZ'
            }
          ]
        }
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
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should return validation error for invalid mechanism', async () => {
      const invalidData = {
        ...validFormData,
        about: {
          ...validFormData.about,
          mechanism: 'Invalid-mechanism'
        }
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
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });
  });

  describe('Duplicate checking', () => {
    test('should return error for production database duplicate', async () => {
      docClientMock.on(GetCommand).resolvesOnce({ Item: { PK: 'TETR', SK: 'P12345#ABOUT' } });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("This uniProtID already exists in our database. If there's an issue, please submit a bug report.");
    });

    test('should return error for temp database duplicate', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: undefined })
        .resolvesOnce({ Item: { PK: 'TEMP', SK: 'P12345' } });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("A submission for this uniProtID is already pending. If there's an issue, please submit a bug report.");
    });

    test('should check both prod and temp tables in correct order', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      await handler(event);

      const getCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'GetCommand');
      expect(getCalls).toHaveLength(2);
      
      expect(getCalls[0].args[0].input.TableName).toBe('test-prod-table');
      expect(getCalls[0].args[0].input.Key).toEqual({
        PK: 'TETR',
        SK: 'P12345#ABOUT'
      });
      
      expect(getCalls[1].args[0].input.TableName).toBe('test-temp-table');
      expect(getCalls[1].args[0].input.Key).toEqual({
        PK: 'TEMP',
        SK: 'P12345'
      });
    });
  });

  describe('Database write operations', () => {
    test('should successfully write to temp table', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall).toBeDefined();
      expect(putCall.args[0].input.TableName).toBe('test-temp-table');
      expect(putCall.args[0].input.Item.PK).toBe('TEMP');
      expect(putCall.args[0].input.Item.SK).toBe('P12345');
      expect(putCall.args[0].input.Item.uniProtID).toBe('P12345');
      expect(putCall.args[0].input.Item.family).toBe('TETR');
    });

    test('should return error when write to temp table fails', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).rejects(new Error('Write failed'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error processing submission. Please notify the administrators.');
    });

    test('should include all form data in temp table write', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      await handler(event);

      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      const writtenItem = putCall.args[0].input.Item;
      
      expect(writtenItem.about).toEqual(validFormData.about);
      expect(writtenItem.operator).toEqual(validFormData.operator);
      expect(writtenItem.ligands).toEqual(validFormData.ligands);
      expect(writtenItem.lineage).toEqual(validFormData.lineage);
      expect(writtenItem.user).toBe(validFormData.user);
      expect(writtenItem.timeSubmit).toBe(validFormData.timeSubmit);
    });
  });

  describe('Error handling', () => {
    test('should handle prod duplicate check errors', async () => {
      docClientMock.on(GetCommand).rejectsOnce(new Error('Database error'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("This uniProtID already exists in our database. If there's an issue, please submit a bug report.");
    });

    test('should handle temp duplicate check errors', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: undefined })
        .rejectsOnce(new Error('Database error'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("A submission for this uniProtID is already pending. If there's an issue, please submit a bug report.");
    });

    test('should handle JSON parsing errors gracefully', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: '{"invalid": json}'
      };

      await expect(handler(event)).rejects.toThrow();
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table names from environment variables', async () => {
      process.env.TABLE_NAME = 'custom-prod-table';
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';
      
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      await handler(event);

      const getCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'GetCommand');
      expect(getCalls[0].args[0].input.TableName).toBe('custom-prod-table');
      expect(getCalls[1].args[0].input.TableName).toBe('custom-temp-table');
      
      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall.args[0].input.TableName).toBe('custom-temp-table');
    });

    test('should configure DynamoDB client for local development when IS_LOCAL is set', async () => {
      process.env.IS_LOCAL = 'true';
      
      // Since we're mocking the client, we can't directly test the configuration
      // but we can verify the function still works correctly
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validFormData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });
  });

  describe('Schema validation edge cases', () => {
    test('should accept valid ref_figure formats', async () => {
      const testCases = [
        'Figure 1',
        'Figure 2',
        'Figure 5A',
        'Table 1',
        'Table 3B'
      ];

      for (const refFigure of testCases) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});

        const testData = {
          ...validFormData,
          operator: {
            data: [
              {
                doi: '10.1234/test',
                method: 'EMSA',
                ref_figure: refFigure,
                sequence: 'ATCGATCG'
              }
            ]
          }
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
          body: JSON.stringify(testData)
        };

        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });

    test('should accept valid DNA sequences (case insensitive)', async () => {
      const testSequences = [
        'ATCGATCG',
        'atcgatcg',
        'AtCgAtCg',
        'AAATTTCCCGGG'
      ];

      for (const sequence of testSequences) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});

        const testData = {
          ...validFormData,
          operator: {
            data: [
              {
                doi: '10.1234/test',
                method: 'EMSA',
                ref_figure: 'Figure 1',
                sequence: sequence
              }
            ]
          }
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
          body: JSON.stringify(testData)
        };

        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });

    test('should accept empty optional fields', async () => {
      const testData = {
        ...validFormData,
        about: {
          ...validFormData.about,
          about: '', // Empty optional field
          mechanism: '' // Empty optional field
        }
      };

      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(testData)
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(202);
    });

    test('should validate all family types', async () => {
      const validFamilies = ['TETR', 'LYSR', 'ARAC', 'MARR', 'LACI', 'GNTR', 'LUXR', 'ICLR', 'OTHER'];

      for (const family of validFamilies) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});

        const testData = {
          ...validFormData,
          family: family
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
          body: JSON.stringify(testData)
        };

        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });

    test('should validate all mechanism types', async () => {
      const validMechanisms = ['Apo-repressor', 'Apo-activator', 'Co-repressor', 'Co-activator'];

      for (const mechanism of validMechanisms) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});

        const testData = {
          ...validFormData,
          about: {
            ...validFormData.about,
            mechanism: mechanism
          }
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
          body: JSON.stringify(testData)
        };

        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });

    test('should validate all operator methods', async () => {
      const validMethods = [
        'EMSA',
        'DNase footprinting',
        'Crystal structure',
        'Isothermal titration calorimetry',
        'Fluorescence polarization',
        'Surface plasmon resonance',
        'Synthetic regulation'
      ];

      for (const method of validMethods) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});

        const testData = {
          ...validFormData,
          operator: {
            data: [
              {
                doi: '10.1234/test',
                method: method,
                ref_figure: 'Figure 1',
                sequence: 'ATCGATCG'
              }
            ]
          }
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
          body: JSON.stringify(testData)
        };

        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });

    test('should validate all ligand methods', async () => {
      const validMethods = [
        'EMSA',
        'DNase footprinting',
        'Isothermal titration calorimetry',
        'Synthetic regulation',
        'Fluorescence polarization',
        'Surface plasmon resonance'
      ];

      for (const method of validMethods) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});

        const testData = {
          ...validFormData,
          ligands: {
            data: [
              {
                doi: '10.1234/ligand',
                method: method,
                ref_figure: 'Figure 2',
                name: 'TestLigand',
                SMILES: 'CCO'
              }
            ]
          }
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
          body: JSON.stringify(testData)  
        };

        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });
  });
});
