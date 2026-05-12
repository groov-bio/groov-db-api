import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/insertFormV2/insertForm.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('InsertFormV2 Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validProtein = {
    alias: 'TestAlias',
    uniProtID: 'P12345',
    accession: 'TEST_ACC',
    mechanism: 'Apo-repressor',
    ligands: [
      {
        doi: '10.1234/ligand',
        method: 'EMSA',
        ref_figure: 'Figure 2',
        name: 'TestLigand',
        SMILES: 'CCO',
      },
    ],
    operators: [
      {
        doi: '10.1234/test',
        method: 'EMSA',
        ref_figure: 'Figure 1',
        sequence: 'ATCGATCG',
      },
    ],
  };

  const validBody = {
    sensor: {
      category: 'TetR',
      about: 'Test sensor description',
      proteins: [validProtein],
    },
    user: 'testuser',
    timeSubmit: 1640995200000,
  };

  const eventFor = (body, method = 'POST', origin = 'https://groov.bio') => ({
    requestContext: { http: { method } },
    headers: { origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
      const result = await handler({
        requestContext: { http: { method: 'OPTIONS' } },
        headers: { origin: 'https://groov.bio' },
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should fall back to localhost for disallowed origins', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor(validBody, 'POST', 'https://evil.example.com'));
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Request validation', () => {
    test('should accept valid sensor-shaped form data', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body);
      expect(typeof body.submissionUUID).toBe('string');
      expect(body.submissionUUID.length).toBeGreaterThan(0);
    });

    test('should return 400 for invalid JSON body', async () => {
      const result = await handler(eventFor('{not json}'));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Invalid JSON in request body');
    });

    test('should return validation error for missing sensor', async () => {
      const result = await handler(eventFor({ user: 'testuser' }));
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.type).toBe('Validation Error');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    test('should return validation error for invalid category', async () => {
      const result = await handler(eventFor({
        ...validBody,
        sensor: { ...validBody.sensor, category: 'INVALID' },
      }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).type).toBe('Validation Error');
    });

    test('should return validation error for empty proteins[]', async () => {
      const result = await handler(eventFor({
        ...validBody,
        sensor: { ...validBody.sensor, proteins: [] },
      }));
      expect(result.statusCode).toBe(400);
    });

    test('should reject protein with no ligands/operators/light/temperature stimuli', async () => {
      const result = await handler(eventFor({
        sensor: {
          category: 'MarR',
          about: 'test',
          proteins: [
            { alias: 'test', uniProtID: 'test', accession: 'test', mechanism: 'Apo-activator' },
            { alias: 'test', uniProtID: 'test', accession: 'test', mechanism: 'Apo-activator' },
          ],
        },
      }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).type).toBe('Validation Error');
    });

    test('should reject protein missing mechanism', async () => {
      const { mechanism, ...proteinNoMechanism } = validProtein;
      const result = await handler(eventFor({
        ...validBody,
        sensor: { ...validBody.sensor, proteins: [proteinNoMechanism] },
      }));
      expect(result.statusCode).toBe(400);
    });

    test('should reject protein with empty ligands/operators arrays', async () => {
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{ ...validProtein, ligands: [], operators: [] }],
        },
      }));
      expect(result.statusCode).toBe(400);
    });

    test('should accept protein with only light_stimuli (no ligands/operators)', async () => {
      docClientMock.on(PutCommand).resolves({});
      const { ligands, operators, ...proteinNoLigOp } = validProtein;
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{
            ...proteinNoLigOp,
            light_stimuli: [{
              wavelength: 470,
              regulatory_effect: 'Activates',
              doi: '10.1234/light',
              method: 'EMSA',
              ref_figure: 'Figure 3',
            }],
          }],
        },
      }));
      expect(result.statusCode).toBe(202);
    });

    test('should return validation error for invalid ref_figure format', async () => {
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{
            ...validProtein,
            operators: [{ ...validProtein.operators[0], ref_figure: 'Invalid Figure Format' }],
          }],
        },
      }));
      expect(result.statusCode).toBe(400);
    });
  });

  describe('v2 schema — Supplementary ref_figure formats', () => {
    test('should accept Supplementary Figure / Supplementary Table on operators and ligands', async () => {
      const testCases = ['Supplementary Figure 1', 'Supplementary Figure 2A', 'Supplementary Table 1'];
      for (const refFigure of testCases) {
        docClientMock.reset();
        docClientMock.on(PutCommand).resolves({});
        const result = await handler(eventFor({
          ...validBody,
          sensor: {
            ...validBody.sensor,
            proteins: [{
              ...validProtein,
              operators: [{ ...validProtein.operators[0], ref_figure: refFigure }],
              ligands: [{ ...validProtein.ligands[0], ref_figure: refFigure }],
            }],
          },
        }));
        expect(result.statusCode).toBe(202);
      }
    });
  });

  describe('v2 schema — new optional fields', () => {
    test('should accept ligand regulatory_effect and kd', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{
            ...validProtein,
            ligands: [{ ...validProtein.ligands[0], regulatory_effect: 'Induces', kd: 1.5 }],
          }],
        },
      }));
      expect(result.statusCode).toBe(202);
    });

    test('should accept operator kd', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{
            ...validProtein,
            operators: [{ ...validProtein.operators[0], kd: 2.0 }],
          }],
        },
      }));
      expect(result.statusCode).toBe(202);
    });

    test('should accept light_stimuli, temperature_stimuli, and mutations', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{
            ...validProtein,
            light_stimuli: [{
              wavelength: 470,
              regulatory_effect: 'Activates',
              doi: '10.1234/light',
              method: 'EMSA',
              ref_figure: 'Figure 3',
            }],
            temperature_stimuli: [{
              temperature: 37,
              regulatory_effect: 'Activates',
              doi: '10.1234/temp',
              method: 'EMSA',
              ref_figure: 'Figure 4',
            }],
            mutations: [{ mutations: ['A23T', 'L45F'], ref_type: 'UniProt', ref_id: 'P12345' }],
          }],
        },
      }));
      expect(result.statusCode).toBe(202);
    });

    test('should accept multi-protein submission', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [
            validProtein,
            { ...validProtein, alias: 'TestAlias2', uniProtID: 'P67890', accession: 'TEST_ACC2' },
          ],
        },
      }));
      expect(result.statusCode).toBe(202);
    });
  });

  describe('Database write operations', () => {
    test('should write a single PutCommand with PK=TEMP and SK=submissionUUID', async () => {
      docClientMock.on(PutCommand).resolves({});
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      const submissionUUID = JSON.parse(result.body).submissionUUID;

      const putCalls = docClientMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(1);
      const input = putCalls[0].args[0].input;
      expect(input.TableName).toBe('test-temp-v2-table');
      expect(input.Item.PK).toBe('TEMP');
      expect(input.Item.SK).toBe(submissionUUID);
      expect(input.Item.sensor).toBeDefined();
      expect(input.Item.sensor.category).toBe('TetR');
    });

    test('should preserve user-supplied fields in the written row', async () => {
      docClientMock.on(PutCommand).resolves({});
      await handler(eventFor(validBody));
      const written = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item;
      expect(written.user).toBe('testuser');
      expect(written.timeSubmit).toBe(1640995200000);
      expect(written.sensor.proteins[0].uniProtID).toBe('P12345');
    });

    test('should return 500 when DynamoDB write fails', async () => {
      docClientMock.on(PutCommand).rejects(new Error('Write failed'));
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('Error processing submission. Please notify the administrators.');
    });
  });

  describe('Environment configuration', () => {
    test('should use TEMP_TABLE_V2_NAME from environment for the write', async () => {
      process.env.TEMP_TABLE_V2_NAME = 'custom-temp-v2-table';
      docClientMock.on(PutCommand).resolves({});
      await handler(eventFor(validBody));
      const putCall = docClientMock.commandCalls(PutCommand)[0];
      expect(putCall.args[0].input.TableName).toBe('custom-temp-v2-table');
    });
  });
});
