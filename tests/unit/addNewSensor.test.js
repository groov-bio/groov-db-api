import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const mockFetch = jest.fn();
const mockCiteConstructor = jest.fn();
const mockCiteInstance = {
  format: jest.fn()
};
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

jest.unstable_mockModule('../../functions/addNewSensor/utils/logger.js', () => ({
  logger: mockLogger
}));

jest.unstable_mockModule('../../functions/addNewSensor/utils/lambdaInvoker.js', () => ({
  invokeLambda: mockInvokeLambda
}));

const { handler } = await import('../../functions/addNewSensor/addNewSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('AddNewSensor Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    mockFetch.mockReset();
    mockCiteConstructor.mockReset();
    mockCiteInstance.format.mockReset();
    mockInvokeLambda.mockReset();
    Object.values(mockLogger).forEach(fn => fn.mockReset());
    
    mockCiteConstructor.mockImplementation(() => mockCiteInstance);
    
    process.env.TABLE_NAME = 'test-prod-table';
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
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
    lineage: {
      child_id: '',
      mutation: '',
      parent_id: '',
      doi: ''
    },
    user: 'testuser',
    timeSubmit: 1640995200000
  };

  const mockUniProtResponse = {
    results: [
      {
        primaryAccession: 'P12345',
        organism: {
          scientificName: 'Escherichia coli',
          taxonId: 511145
        },
        genes: [
          {
            geneName: {
              value: 'testGene'
            }
          }
        ],
        sequence: {
          value: 'MKVLWAALLVTFLAGCQAKVE'
        },
        uniProtKBCrossReferences: [
          {
            database: 'RefSeq',
            id: 'NP_414542.1'
          },
          {
            database: 'PDB',
            id: '1ABC'
          },
          {
            database: 'KEGG',
            id: 'eco:b0001'
          }
        ]
      }
    ]
  };

  const mockCitationResponse = [
    {
      title: 'Test Paper Title',
      author: [
        {
          family: 'Smith',
          given: 'John'
        }
      ],
      issued: {
        'date-parts': [[2023]]
      },
      'container-title': 'Test Journal',
      DOI: '10.1234/test',
      URL: 'https://doi.org/10.1234/test'
    }
  ];

  const mockPDBResponse = {
    data: {
      entry: {
        rcsb_primary_citation: {
          pdbx_database_id_DOI: '10.1234/structure'
        },
        exptl: [
          {
            method: 'X-RAY DIFFRACTION'
          }
        ]
      }
    }
  };

  const mockOperonResponse = {
    body: JSON.stringify({
      operon: ['gene1', 'gene2', 'gene3']
    })
  };

  const setupSuccessfulMocks = () => {
    docClientMock.on(GetCommand).resolves({ Item: undefined });
    docClientMock.on(BatchWriteCommand).resolves({});
    
    mockFetch.mockImplementation((url, options) => {
      if (url.includes('rest.uniprot.org')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockUniProtResponse)
        });
      } else if (url.includes('data.rcsb.org/graphql')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockPDBResponse)
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({})
      });
    });
    
    mockInvokeLambda.mockResolvedValue(mockOperonResponse);
    mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));
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
      expect(result.body).toBe('');
    });

    test('should use allowed origin for groov.bio', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use default origin for disallowed origins', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Request validation', () => {
    test('should return error for missing request body', async () => {
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

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Missing request body');
    });

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
        body: '{"invalid": json}'
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Invalid JSON in request body');
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
      expect(body.type).toBe('Validation Error');
      expect(body.errors).toBeInstanceOf(Array);
    });

    test('should return validation error for invalid family', async () => {
      const invalidData = {
        ...validSensorData,
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
      expect(body.type).toBe('Validation Error');
    });

    test('should return validation error for invalid operator method', async () => {
      const invalidData = {
        ...validSensorData,
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
      expect(body.type).toBe('Validation Error');
    });

    test('should return validation error for invalid DNA sequence', async () => {
      const invalidData = {
        ...validSensorData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'EMSA',
              ref_figure: 'Figure 1',
              sequence: 'XYZ'
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
      expect(body.type).toBe('Validation Error');
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
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('uniProtID already exists in production.');
    });

    test('should return error for temp database duplicate', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: undefined })
        .resolvesOnce({ Item: { PK: 'TETR', SK: 'P12345#ABOUT' } });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('uniProtID already exists in temp.');
    });
  });

  describe('UniProt API integration', () => {
    test('should successfully call UniProt API', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(mockFetch).toHaveBeenCalled();
      const firstCall = mockFetch.mock.calls[0];
      expect(firstCall[0]).toContain('https://rest.uniprot.org/uniprotkb/search');
      expect(firstCall[1]).toHaveProperty('signal');
    });

    test('should return error for invalid uniProtID', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [] })
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
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('uniProtID is invalid - no results found');
    });

    test('should handle UniProt API errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error')
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
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error calling UniProt API');
    });

    test('should handle fetch timeout', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockRejectedValue(new Error('Timeout'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error calling UniProt API');
    });

    test('should handle citation-js errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      
      const mockUniProtResponseNoPDB = {
        results: [
          {
            primaryAccession: 'P12345',
            organism: {
              scientificName: 'Escherichia coli',
              taxonId: 511145
            },
            genes: [
              {
                geneName: {
                  value: 'testGene'
                }
              }
            ],
            sequence: {
              value: 'MKVLWAALLVTFLAGCQAKVE'
            },
            uniProtKBCrossReferences: [
              {
                database: 'RefSeq',
                id: 'NP_414542.1'
              },
              {
                database: 'KEGG',
                id: 'eco:b0001'
              }
            ]
          }
        ]
      };
      
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockUniProtResponseNoPDB)
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({})
        });
      });
      
      mockInvokeLambda.mockResolvedValue(mockOperonResponse);
      
      mockCiteConstructor.mockImplementation((doi) => {
        if (doi === '10.1234/test') {
          throw new Error('Citation error');
        }
        return mockCiteInstance;
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
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toMatch(/Error (with|parsing) citation-js/);
    });
  });

  describe('Citation processing', () => {
    test('should process DOI citations correctly', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(mockCiteConstructor).toHaveBeenCalledWith('10.1234/test');
      expect(mockCiteConstructor).toHaveBeenCalledWith('10.1234/ligand');
    });
  });

  describe('PDB API integration', () => {
    test('should process PDB structures correctly', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const pdbCall = mockFetch.mock.calls.find(call => call[0] === 'https://data.rcsb.org/graphql');
      expect(pdbCall).toBeDefined();
      expect(pdbCall[1].method).toBe('post');
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
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockUniProtWithPDB)
          });
        } else if (url.includes('data.rcsb.org/graphql')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('PDB API error')
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({})
        });
      });

      mockCiteInstance.format.mockReturnValue(JSON.stringify([]));
      mockInvokeLambda.mockResolvedValue(mockOperonResponse);

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Something went wrong with PDB API call');
    });
  });

  describe('Operon Lambda integration', () => {
    test('should call operon lambda with user-provided accession', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(mockInvokeLambda).toHaveBeenCalledWith(
        'getOperon',
        'test-operon-arn',
        expect.objectContaining({
          queryStringParameters: {
            id: 'TEST_ACC'
          }
        }),
        null,
        'GET'
      );
    });

    test('should handle operon lambda errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockUniProtResponse)
      });
      mockInvokeLambda.mockRejectedValue(new Error('Lambda error'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Something went wrong with operon lambda call');
    });
  });

  describe('Database operations', () => {
    test('should successfully write to DynamoDB', async () => {
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Processing completed successfully');

      expect(docClientMock.commandCalls(BatchWriteCommand).length).toBeGreaterThan(0);
    });

    test('should handle DynamoDB write errors', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(BatchWriteCommand).rejects(new Error('DynamoDB error'));
      
      mockFetch.mockImplementation((url) => {
        if (url.includes('rest.uniprot.org')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockUniProtResponse)
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockPDBResponse)
        });
      });
      
      mockInvokeLambda.mockResolvedValue(mockOperonResponse);
      mockCiteInstance.format.mockReturnValue(JSON.stringify(mockCitationResponse));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error writing to DynamoDB.');
    });
  });

  describe('Complete flow integration', () => {
    test('should handle complete successful flow with all data types', async () => {
      setupSuccessfulMocks();

      const completeData = {
        ...validSensorData,
        operator: {
          data: [
            {
              doi: '10.1234/operator',
              method: 'EMSA',
              ref_figure: 'Figure 3',
              sequence: 'ATCGATCGATCG'
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
        body: JSON.stringify(completeData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockCiteConstructor).toHaveBeenCalledTimes(2);
      expect(mockInvokeLambda).toHaveBeenCalledTimes(1);
      
      expect(docClientMock.commandCalls(GetCommand).length).toBe(2);
      expect(docClientMock.commandCalls(BatchWriteCommand).length).toBe(1);
    });

    test('should handle sensor without optional data', async () => {
      const minimalData = {
        uniProtID: 'P12345',
        family: 'TETR',
        about: {
          about: '',
          accession: 'TEST_ACC',
          alias: 'TestAlias',
          mechanism: ''
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

      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(minimalData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });
  });

  describe('Error handling edge cases', () => {
    test('should handle unhandled exceptions', async () => {
      docClientMock.on(GetCommand).rejects(new Error('Unexpected error'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('uniProtID already exists in production.');
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table names from environment variables', async () => {
      process.env.TABLE_NAME = 'custom-prod-table';
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';
      
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      await handler(event);

      const getCalls = docClientMock.commandCalls(GetCommand);
      expect(getCalls[0].args[0].input.TableName).toBe('custom-prod-table');
      expect(getCalls[1].args[0].input.TableName).toBe('custom-temp-table');
      
      const batchWriteCalls = docClientMock.commandCalls(BatchWriteCommand);
      if (batchWriteCalls.length > 0) {
        expect(batchWriteCalls[0].args[0].input.RequestItems).toHaveProperty('custom-temp-table');
      }
    });

    test('should configure DynamoDB client for local development when IS_LOCAL is set', async () => {
      process.env.IS_LOCAL = 'true';
      
      setupSuccessfulMocks();

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });
  });
});
