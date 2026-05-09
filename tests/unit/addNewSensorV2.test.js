import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const mockFetch = jest.fn();
const mockCiteConstructor = jest.fn();
const mockCiteInstance = { format: jest.fn() };
const mockInvokeLambda = jest.fn();
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

mockCiteConstructor.mockImplementation(() => mockCiteInstance);

jest.unstable_mockModule('citation-js', () => ({
  default: mockCiteConstructor
}));

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch
}));

jest.unstable_mockModule('../../functions/addNewSensorV2/utils/logger.js', () => ({
  logger: mockLogger
}));

jest.unstable_mockModule('../../functions/addNewSensorV2/utils/lambdaInvoker.js', () => ({
  invokeLambda: mockInvokeLambda
}));

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
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    mockFetch.mockReset();
    mockCiteConstructor.mockReset();
    mockCiteInstance.format.mockReset();
    mockInvokeLambda.mockReset();
    Object.values(mockLogger).forEach(fn => fn.mockReset());

    mockCiteConstructor.mockImplementation(() => mockCiteInstance);

    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
    process.env.GET_OPERON_FUNCTION_ARN = 'test-operon-arn';
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validSensorData = {
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
    lineage: { child_id: '', mutation: '', parent_id: '', doi: '' },
    user: 'testuser',
    timeSubmit: 1640995200000
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
        { database: 'KEGG', id: 'eco:b0001' }
      ]
    }]
  };

  const mockCitationResponse = [{
    title: 'Test Paper Title',
    author: [{ family: 'Smith', given: 'John' }],
    issued: { 'date-parts': [[2023]] },
    'container-title': 'Test Journal',
    DOI: '10.1234/test',
    URL: 'https://doi.org/10.1234/test'
  }];

  const mockPDBResponse = {
    data: {
      entry: {
        rcsb_primary_citation: { pdbx_database_id_DOI: '10.1234/structure' },
        exptl: [{ method: 'X-RAY DIFFRACTION' }]
      }
    }
  };

  const mockOperonResponse = {
    body: JSON.stringify({ operon: ['gene1', 'gene2', 'gene3'] })
  };

  const setupSuccessfulMocks = () => {
    docClientMock.on(GetCommand).resolves({ Item: undefined });
    docClientMock.on(PutCommand).resolves({});

    mockFetch.mockImplementation((url) => {
      if (url.includes('rest.uniprot.org')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
      } else if (url.includes('data.rcsb.org/graphql')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPDBResponse) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    mockInvokeLambda.mockResolvedValue(mockOperonResponse);
    mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
  };

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
      const event = {
        requestContext: { http: { method: 'OPTIONS' } },
        headers: { origin: 'https://groov.bio' }
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.body).toBe('');
    });

    test('should use allowed origin for groov.bio', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });
  });

  describe('Request validation', () => {
    test('should return error for missing request body', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' }
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing request body');
    });

    test('should return error for invalid JSON', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: '{"invalid": json}'
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Invalid JSON in request body');
    });

    test('should return validation error for missing required fields', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'TETR' })
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.type).toBe('Validation Error');
      expect(body.errors).toBeInstanceOf(Array);
    });

    test('should return validation error for invalid family', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ ...validSensorData, family: 'INVALID_FAMILY' })
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('v2 schema — Supplementary ref_figure formats', () => {
    test('should accept Supplementary Figure and Supplementary Table', async () => {
      const testCases = ['Supplementary Figure 1', 'Supplementary Figure 2A', 'Supplementary Table 3'];
      for (const refFigure of testCases) {
        setupSuccessfulMocks();
        const event = {
          requestContext: { http: { method: 'POST' } },
          headers: { origin: 'https://groov.bio' },
          body: JSON.stringify({
            ...validSensorData,
            operator: { data: [{ doi: '10.1234/test', method: 'EMSA', ref_figure: refFigure, sequence: 'ATCGATCG' }] }
          })
        };
        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });
  });

  describe('Duplicate checking (temp only — no prod check)', () => {
    test('should return 409 when processed temp entry already exists', async () => {
      docClientMock.on(GetCommand).resolvesOnce({ Item: { PK: 'TetR', SK: 'P12345' } });
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).message).toBe('uniProtID already exists in processed temp.');
    });
  });

  describe('UniProt API integration', () => {
    test('should successfully call UniProt API', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(202);
      expect(mockFetch).toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][0]).toContain('rest.uniprot.org');
    });

    test('should return error for invalid uniProtID', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [] }) });
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('uniProtID is invalid - no results found');
    });

    test('should handle UniProt API errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Server error') });
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('Error calling UniProt API');
    });
  });

  describe('PDB API integration', () => {
    test('should process PDB structures correctly', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(202);
      const pdbCall = mockFetch.mock.calls.find(call => call[0] === 'https://data.rcsb.org/graphql');
      expect(pdbCall).toBeDefined();
      expect(pdbCall[1].body).toContain('1ABC');
    });

    test('should handle PDB API errors', async () => {
      const mockUniProtWithPDB = {
        results: [{
          primaryAccession: 'P12345',
          organism: { scientificName: 'Escherichia coli', taxonId: 511145 },
          genes: [{ geneName: { value: 'testGene' } }],
          sequence: { value: 'MKVLWAALLVTFLAGCQAKVE' },
          uniProtKBCrossReferences: [{ database: 'PDB', id: '1ABC' }]
        }]
      };
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtWithPDB) });
        }
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('PDB error') });
      });
      mockCiteInstance.format.mockReturnValue(JSON.stringify([]));
      mockInvokeLambda.mockResolvedValue(mockOperonResponse);
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('Something went wrong with PDB API call');
    });
  });

  describe('Operon Lambda integration', () => {
    test('should call operon lambda with user-provided accession', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      await handler(event);
      expect(mockInvokeLambda).toHaveBeenCalledWith(
        'getOperon',
        'test-operon-arn',
        expect.objectContaining({ queryStringParameters: { id: 'TEST_ACC' } }),
        null,
        'GET'
      );
    });

    test('should handle operon lambda errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
      mockInvokeLambda.mockRejectedValue(new Error('Lambda error'));
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('Something went wrong with operon lambda call');
    });
  });

  describe('Database operations', () => {
    test('should write a single PutCommand row to the v2 temp table', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body).message).toBe('Processing completed successfully');

      const putCalls = docClientMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(1);
      expect(putCalls[0].args[0].input.TableName).toBe('test-temp-v2-table');
      expect(putCalls[0].args[0].input.Item.PK).toBe('TetR');
      expect(putCalls[0].args[0].input.Item.SK).toBe('P12345');
      expect(putCalls[0].args[0].input.Item.data).toBeDefined();
    });

    test('should write a v2-shaped sensor object', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      await handler(event);
      const putCalls = docClientMock.commandCalls(PutCommand);
      const written = putCalls[0].args[0].input.Item.data;
      expect(written.id).toBeNull();
      expect(written.type).toBe('One Component');
      expect(written.category).toBe('TetR');
      expect(Array.isArray(written.proteins)).toBe(true);
      expect(written.proteins[0].uniprot_id).toBe('P12345');
      expect(Array.isArray(written.proteins[0].stimulus)).toBe(true);
      expect(Array.isArray(written.proteins[0].dna)).toBe(true);
      expect(Array.isArray(written.proteins[0].references)).toBe(true);
    });

    test('should handle DynamoDB write errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).rejects(new Error('DynamoDB error'));
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockUniProtResponse) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPDBResponse) });
      });
      mockInvokeLambda.mockResolvedValue(mockOperonResponse);
      mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('Error writing to DynamoDB.');
    });
  });

  describe('Complete flow integration', () => {
    test('should make exactly 1 GetCommand (temp only) and 1 PutCommand', async () => {
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      await handler(event);
      expect(docClientMock.commandCalls(GetCommand).length).toBe(1);
      expect(docClientMock.commandCalls(PutCommand).length).toBe(1);
    });

    test('should handle sensor without optional ligands/operators', async () => {
      const minimalData = {
        uniProtID: 'P12345',
        family: 'TETR',
        about: { about: '', accession: 'TEST_ACC', alias: 'TestAlias', mechanism: '' },
        lineage: { child_id: '', mutation: '', parent_id: '', doi: '' },
        user: 'testuser',
        timeSubmit: 1640995200000
      };
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(minimalData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(202);
    });
  });

  describe('Environment configuration', () => {
    test('should use TEMP_TABLE_V2_NAME for all DynamoDB operations', async () => {
      process.env.TEMP_TABLE_V2_NAME = 'custom-temp-v2-table';
      setupSuccessfulMocks();
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validSensorData)
      };
      await handler(event);
      const getCalls = docClientMock.commandCalls(GetCommand);
      expect(getCalls[0].args[0].input.TableName).toBe('custom-temp-v2-table');
      const putCalls = docClientMock.commandCalls(PutCommand);
      expect(putCalls[0].args[0].input.TableName).toBe('custom-temp-v2-table');
    });
  });
});
