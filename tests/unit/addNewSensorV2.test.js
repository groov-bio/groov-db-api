import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const mockFetch = jest.fn();
const mockCiteConstructor = jest.fn();
const mockCiteInstance = { format: jest.fn() };
const mockAcc2operon = jest.fn();
const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

mockCiteConstructor.mockImplementation(() => mockCiteInstance);

jest.unstable_mockModule('citation-js', () => ({ default: mockCiteConstructor }));
jest.unstable_mockModule('node-fetch', () => ({ default: mockFetch }));
jest.unstable_mockModule('../../functions/addNewSensorV2/utils/logger.js', () => ({ logger: mockLogger }));
jest.unstable_mockModule('../../functions/addNewSensorV2/utils/operon.js', () => ({ acc2operon: mockAcc2operon }));

const { handler } = await import('../../functions/addNewSensorV2/addNewSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('AddNewSensorV2 Function', () => {
  const SUB_UUID = 'sub-uuid-123';

  // Per-protein: `family` required (not `mechanism`).
  // Sensor level: `mechanism` (optional), no `category`.
  const validProtein = {
    alias: 'TestAlias',
    uniProtID: 'P12345',
    accession: 'TEST_ACC',
    family: 'TetR',
    ligands: [{
      doi: '10.1234/ligand',
      method: 'EMSA',
      ref_figure: 'Figure 2',
      name: 'TestLigand',
      SMILES: 'CCO',
    }],
    operators: [{
      doi: '10.1234/test',
      method: 'EMSA',
      ref_figure: 'Figure 1',
      sequence: 'ATCGATCG',
    }],
  };

  const validBody = {
    sensor: {
      mechanism: 'Apo-repressor',
      about: 'Test sensor description',
      proteins: [validProtein],
    },
    user: 'testuser',
    timeSubmit: 1640995200000,
    submissionUUID: SUB_UUID,
  };

  const mockUniProtResponse = {
    results: [{
      primaryAccession: 'P12345',
      organism: { scientificName: 'Escherichia coli', taxonId: 511145 },
      genes: [{ geneName: { value: 'testGene' } }],
      sequence: { value: 'MKVLWAALLVTFLAGCQAKVE' },
      uniProtKBCrossReferences: [
        { database: 'RefSeq', id: 'NP_414542.1' },
        { database: 'PDB', id: '1ABC' },
        { database: 'KEGG', id: 'eco:b0001' },
      ],
    }],
  };

  const mockCitationResponse = [{
    title: 'Test Paper Title',
    author: [{ family: 'Smith', given: 'John' }],
    issued: { 'date-parts': [[2023]] },
    'container-title': 'Test Journal',
    DOI: '10.1234/test',
    URL: 'https://doi.org/10.1234/test',
  }];

  const mockPDBResponse = {
    data: {
      entry: {
        rcsb_primary_citation: { pdbx_database_id_DOI: '10.1234/structure' },
        exptl: [{ method: 'X-RAY DIFFRACTION' }],
      },
    },
  };

  // acc2operon now returns the parsed operon object directly (no Lambda envelope).
  const mockOperonResponse = {
    operon: [{ link: 'g1', start: 1, Stop: 100, description: 'd', direction: '+' }],
    regIndex: 0,
    genome: 'NC_TEST.1',
  };

  const setupSuccessfulMocks = () => {
    docClientMock.on(GetCommand).resolves({ Item: undefined });
    docClientMock.on(PutCommand).resolves({});

    mockFetch.mockImplementation((url) => {
      if (url.includes('rest.uniprot.org')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
      }
      if (url.includes('data.rcsb.org/graphql')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPDBResponse) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    mockAcc2operon.mockResolvedValue(mockOperonResponse);
    mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
  };

  const eventFor = (body, method = 'POST', origin = 'https://groov.bio') => ({
    requestContext: { http: { method } },
    headers: { origin },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    mockFetch.mockReset();
    mockCiteConstructor.mockReset();
    mockCiteInstance.format.mockReset();
    mockAcc2operon.mockReset();
    Object.values(mockLogger).forEach(fn => fn.mockReset());
    mockCiteConstructor.mockImplementation(() => mockCiteInstance);

    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
    process.env.PROCESSED_TEMP_TABLE_V2_NAME = 'test-processed-temp-v2-table';
    process.env.GET_OPERON_FUNCTION_ARN = 'test-operon-arn';
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
      const result = await handler(eventFor(undefined, 'OPTIONS'));
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.body).toBe('');
    });

    test('should use allowed origin for groov.bio', async () => {
      setupSuccessfulMocks();
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should fall back to localhost for disallowed origins', async () => {
      setupSuccessfulMocks();
      const result = await handler(eventFor(validBody, 'POST', 'https://evil.example.com'));
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Request validation', () => {
    test('should return 400 for missing request body', async () => {
      const result = await handler(eventFor(undefined));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing request body');
    });

    test('should return 400 for invalid JSON', async () => {
      const result = await handler(eventFor('{"invalid": json}'));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Invalid JSON in request body');
    });

    test('should return validation error for malformed sensor (missing required proteins)', async () => {
      const result = await handler(eventFor({
        sensor: { mechanism: 'Apo-repressor' },
        submissionUUID: SUB_UUID,
      }));
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.type).toBe('Validation Error');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    test('should return validation error for invalid mechanism', async () => {
      const result = await handler(eventFor({
        ...validBody,
        sensor: { ...validBody.sensor, mechanism: 'INVALID_MECHANISM' },
      }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).type).toBe('Validation Error');
    });

    test('should return 400 if submissionUUID is not supplied (inline mode)', async () => {
      setupSuccessfulMocks();
      const { submissionUUID, ...inlineNoUUID } = validBody;
      const result = await handler(eventFor(inlineNoUUID));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('submissionUUID is required');
    });
  });

  describe('v2 schema — Supplementary ref_figure formats', () => {
    test('should accept Supplementary Figure and Supplementary Table on operators/ligands', async () => {
      const testCases = ['Supplementary Figure 1', 'Supplementary Figure 2A', 'Supplementary Table 3'];
      for (const refFigure of testCases) {
        setupSuccessfulMocks();
        const body = {
          ...validBody,
          sensor: {
            ...validBody.sensor,
            proteins: [{
              ...validProtein,
              operators: [{ ...validProtein.operators[0], ref_figure: refFigure }],
              ligands: [{ ...validProtein.ligands[0], ref_figure: refFigure }],
            }],
          },
        };
        const result = await handler(eventFor(body));
        expect(result.statusCode).toBe(202);
      }
    });
  });

  describe('Submission UUID modes', () => {
    test('should fetch raw temp row when called with only submissionUUID', async () => {
      docClientMock
        .on(GetCommand, { TableName: 'test-temp-v2-table' })
        .resolves({ Item: { PK: 'TEMP', SK: SUB_UUID, sensor: validBody.sensor, user: 'testuser', timeSubmit: 1 } })
        .on(GetCommand, { TableName: 'test-processed-temp-v2-table' })
        .resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPDBResponse) });
      });
      mockAcc2operon.mockResolvedValue(mockOperonResponse);
      mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));

      const result = await handler(eventFor({ submissionUUID: SUB_UUID }));
      expect(result.statusCode).toBe(202);
    });

    test('should return 404 when raw temp row missing for given submissionUUID', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      const result = await handler(eventFor({ submissionUUID: 'unknown-uuid' }));
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).message).toBe('No submission found for the provided UUID');
    });
  });

  describe('Duplicate checking (processed temp — PK=PROCESSED)', () => {
    test('should return 409 when processed temp entry already exists', async () => {
      docClientMock.on(GetCommand).resolves({ Item: { PK: 'PROCESSED', SK: SUB_UUID } });
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).message).toBe('A processed entry already exists for this submission');
    });

    test('should query processed-temp table with PK=PROCESSED and SK=submissionUUID', async () => {
      setupSuccessfulMocks();
      await handler(eventFor(validBody));
      const dupeCall = docClientMock.commandCalls(GetCommand)
        .find(c => c.args[0].input.TableName === 'test-processed-temp-v2-table');
      expect(dupeCall).toBeDefined();
      expect(dupeCall.args[0].input.Key).toEqual({ PK: 'PROCESSED', SK: SUB_UUID });
    });
  });

  describe('UniProt API integration', () => {
    test('should successfully call UniProt API', async () => {
      setupSuccessfulMocks();
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      expect(mockFetch).toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][0]).toContain('rest.uniprot.org');
    });

    test('should return 400 when UniProt returns no results', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [] }) });
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('No UniProt results for P12345');
    });

    test('should return 500 when UniProt API returns non-OK status', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Server error') });
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toContain('UniProt API error');
    });
  });

  describe('PDB API integration', () => {
    test('should query PDB GraphQL with the cross-referenced PDB id', async () => {
      setupSuccessfulMocks();
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      const pdbCall = mockFetch.mock.calls.find(c => c[0] === 'https://data.rcsb.org/graphql');
      expect(pdbCall).toBeDefined();
      expect(pdbCall[1].body).toContain('1ABC');
    });

    test('should return 500 when PDB API errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
        }
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('PDB error') });
      });
      mockAcc2operon.mockResolvedValue(mockOperonResponse);
      mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toContain('PDB API error');
    });
  });

  describe('Operon resolver integration', () => {
    test('should call acc2operon with user-provided accession', async () => {
      setupSuccessfulMocks();
      await handler(eventFor(validBody));
      expect(mockAcc2operon).toHaveBeenCalledWith('TEST_ACC');
    });

    test('should propagate operon resolver errors as 500', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPDBResponse) });
      });
      mockAcc2operon.mockRejectedValue(new Error('Operon resolver error'));
      mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('Operon resolver error');
    });
  });

  describe('Database write operations', () => {
    test('should write a single PutCommand row to the processed-temp v2 table with PK=PROCESSED', async () => {
      setupSuccessfulMocks();
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body).message).toBe('Processing completed successfully');

      const putCalls = docClientMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(1);
      const input = putCalls[0].args[0].input;
      expect(input.TableName).toBe('test-processed-temp-v2-table');
      expect(input.Item.PK).toBe('PROCESSED');
      expect(input.Item.SK).toBe(SUB_UUID);
      expect(input.Item.proposed_grv_id).toBeNull();
      expect(input.Item.data).toBeDefined();
    });

    test('should write a v2-shaped sensor object', async () => {
      setupSuccessfulMocks();
      await handler(eventFor(validBody));
      const written = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item.data;
      expect(written.id).toBeNull();
      expect(written.proposed_grv_id).toBeNull();
      expect(written.type).toBe('One Component');
      expect(Array.isArray(written.proteins)).toBe(true);
      expect(written.proteins[0].uniprot_id).toBe('P12345');
      expect(written.proteins[0].refseq_id).toBe('TEST_ACC');
      expect(Array.isArray(written.proteins[0].stimulus)).toBe(true);
      expect(Array.isArray(written.proteins[0].dna)).toBe(true);
      expect(Array.isArray(written.proteins[0].references)).toBe(true);
      expect(Array.isArray(written.proteins[0].structures)).toBe(true);
      expect(Array.isArray(written.proteins[0].origin)).toBe(true);
      // Stimulus uses snake_case stimulus_type (matches the V2 contract), never the
      // legacy camelCase stimulusType.
      expect(JSON.stringify(written)).not.toContain('"stimulusType"');
      for (const stim of written.proteins[0].stimulus) {
        if ('small_molecule' in stim || 'light' in stim || 'temperature' in stim) continue;
        expect(Array.isArray(stim.stimulus_type)).toBe(true);
      }
      // interaction is deprecated dead data — new sensors no longer populate it.
      for (const ref of written.proteins[0].references) {
        expect(ref.interaction).toEqual([]);
      }
    });

    test('should infer Two Component when sensor has 2 proteins', async () => {
      setupSuccessfulMocks();
      const body = {
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [
            validProtein,
            { ...validProtein, alias: 'TestAlias2', uniProtID: 'P67890', accession: 'TEST_ACC2' },
          ],
        },
      };
      const result = await handler(eventFor(body));
      expect(result.statusCode).toBe(202);
      const written = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item.data;
      expect(written.type).toBe('Two Component');
      expect(written.proteins).toHaveLength(2);
    });

    test('should accept the "Signal transduction" mechanism for a two-component system', async () => {
      setupSuccessfulMocks();
      const body = {
        ...validBody,
        sensor: {
          ...validBody.sensor,
          mechanism: 'Signal transduction',
          proteins: [
            { ...validProtein, family: 'HisKA' },
            { ...validProtein, alias: 'TestAlias2', uniProtID: 'P67890', accession: 'TEST_ACC2', family: 'OmpR' },
          ],
        },
      };
      const result = await handler(eventFor(body));
      expect(result.statusCode).toBe(202);
      const written = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item.data;
      expect(written.type).toBe('Two Component');
    });

    test('should reject OmpR/HisKA families on a single-protein submission', async () => {
      setupSuccessfulMocks();
      const body = {
        ...validBody,
        sensor: { ...validBody.sensor, proteins: [{ ...validProtein, family: 'OmpR' }] },
      };
      const result = await handler(eventFor(body));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).type).toBe('Validation Error');
    });

    test('should return 500 when DynamoDB write fails', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).rejects(new Error('DynamoDB error'));
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPDBResponse) });
      });
      mockAcc2operon.mockResolvedValue(mockOperonResponse);
      mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
      const result = await handler(eventFor(validBody));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('Error writing processed sensor row');
    });
  });

  describe('Complete flow integration', () => {
    test('should make exactly 1 GetCommand (processed dupe) and 1 PutCommand', async () => {
      setupSuccessfulMocks();
      await handler(eventFor(validBody));
      expect(docClientMock.commandCalls(GetCommand).length).toBe(1);
      expect(docClientMock.commandCalls(PutCommand).length).toBe(1);
    });

    test('should handle protein without optional ligands/operators', async () => {
      setupSuccessfulMocks();
      const minimalBody = {
        sensor: {
          mechanism: 'Apo-repressor',
          about: '',
          proteins: [{
            alias: 'TestAlias',
            uniProtID: 'P12345',
            accession: 'TEST_ACC',
            family: 'TetR',
          }],
        },
        user: 'testuser',
        timeSubmit: 1640995200000,
        submissionUUID: SUB_UUID,
      };
      const result = await handler(eventFor(minimalBody));
      expect(result.statusCode).toBe(202);
    });
  });

  describe('UniProt ID required, RefSeq optional (item 7)', () => {
    test('should reject a protein with no uniProtID before any enrichment', async () => {
      const { uniProtID, ...proteinNoUni } = validProtein;
      const result = await handler(eventFor({
        ...validBody,
        sensor: { ...validBody.sensor, proteins: [proteinNoUni] },
      }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).type).toBe('Validation Error');
      // UniProt must not be called — validation fails first.
      const uniCall = mockFetch.mock.calls.find(c => String(c[0]).includes('rest.uniprot.org'));
      expect(uniCall).toBeUndefined();
    });

    test('should reject an empty-string uniProtID', async () => {
      const result = await handler(eventFor({
        ...validBody,
        sensor: {
          ...validBody.sensor,
          proteins: [{ ...validProtein, uniProtID: '' }],
        },
      }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).type).toBe('Validation Error');
    });

    test('should still process a protein with no accession when uniProtID is present', async () => {
      setupSuccessfulMocks();
      const { accession, ...proteinNoAccession } = validProtein;
      const result = await handler(eventFor({
        ...validBody,
        sensor: { ...validBody.sensor, proteins: [proteinNoAccession] },
      }));
      expect(result.statusCode).toBe(202);
    });
  });

  describe('Environment configuration', () => {
    test('should use PROCESSED_TEMP_TABLE_V2_NAME for dupe check and write', async () => {
      process.env.PROCESSED_TEMP_TABLE_V2_NAME = 'custom-processed-table';
      setupSuccessfulMocks();
      await handler(eventFor(validBody));
      const getCalls = docClientMock.commandCalls(GetCommand);
      expect(getCalls[0].args[0].input.TableName).toBe('custom-processed-table');
      const putCalls = docClientMock.commandCalls(PutCommand);
      expect(putCalls[0].args[0].input.TableName).toBe('custom-processed-table');
    });
  });
});
