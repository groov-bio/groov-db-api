import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const mockUpdateMainIndex = jest.fn();
const mockUpdateFamilyIndex = jest.fn();
const mockSaveSensorFile = jest.fn();
const mockUpdateAllSensorsGzip = jest.fn();
const mockUpdateFingerprints = jest.fn();

jest.unstable_mockModule('../../functions/approveProcessedSensor/s3Updater.js', () => ({
  updateMainIndex: mockUpdateMainIndex,
  updateFamilyIndex: mockUpdateFamilyIndex,
  saveSensorFile: mockSaveSensorFile,
  updateAllSensorsGzip: mockUpdateAllSensorsGzip,
  updateFingerprints: mockUpdateFingerprints
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
  console.warn.mockRestore();
});

const { handler } = await import('../../functions/approveProcessedSensor/approveProcessedSensor.js');

describe('ApproveProcessedSensor Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    mockUpdateMainIndex.mockReset();
    mockUpdateFamilyIndex.mockReset();
    mockSaveSensorFile.mockReset();
    mockUpdateAllSensorsGzip.mockReset();
    mockUpdateFingerprints.mockReset();
    
    process.env.TABLE_NAME = 'test-prod-table';
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
    delete process.env.SKIP_TEMP_DELETE;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockSensorData = [
    {
      PK: 'GPCR',
      SK: 'P12345#ABOUT',
      category: 'about',
      alias: 'TestSensor',
      family: 'GPCR',
      mechanism: 'positive',
      description: 'Test sensor description',
      uniprotID: 'P12345'
    },
    {
      PK: 'GPCR',
      SK: 'P12345#LIGANDS',
      category: 'ligands',
      ligands: [
        {
          name: 'TestLigand',
          doi: '10.1234/test',
          method: 'binding',
          ref_figure: 'Fig1A',
          fullDOI: {
            title: 'Test Paper',
            authors: 'Test Author',
            year: 2023,
            journal: 'Test Journal',
            doi: '10.1234/test',
            url: 'https://doi.org/10.1234/test'
          }
        }
      ]
    },
    {
      PK: 'GPCR',
      SK: 'P12345#OPERATOR',
      category: 'operator',
      operators: [
        {
          sequence: 'ATCG',
          doi: '10.1234/operator',
          method: 'EMSA',
          ref_figure: 'Fig2B'
        }
      ]
    },
    {
      PK: 'GPCR',
      SK: 'P12345#STRUCTURE',
      category: 'structure',
      data: [
        {
          PDB_code: '1ABC',
          doi: '10.1234/structure',
          method: 'X-ray',
          ref_figure: 'Fig3'
        }
      ]
    },
    {
      PK: 'GPCR',
      SK: 'P12345#OPERON',
      category: 'operon',
      operon: ['gene1', 'gene2']
    }
  ];

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

    test('should handle Origin header (capital O)', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { Origin: 'https://www.groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use default origin when no origin header provided', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: {},
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB query errors', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('DynamoDB query failed'));

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error reading item from temp table');
    });

    test('should handle batch generation errors', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: null });

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error creating batch to write to prod');
    });

    test('should handle batch write errors to production table', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).callsFake((input) => {
        if (input.input.TableName === process.env.TABLE_NAME) {
          return Promise.reject(new Error('BatchWrite to production failed'));
        }
        return Promise.resolve({});
      });

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error writing batch to prod');
    });


    test('should handle delete request creation errors', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: '', uniProtID: '' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should handle sensor data formatting errors', async () => {
      const malformedData = [
        {
          PK: 'GPCR',
          SK: 'P12345#ABOUT',
          category: 'about',
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: malformedData });
      docClientMock.on(BatchWriteCommand).resolves({});

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });
  });

  describe('S3 update scenarios', () => {
    test('should handle S3 update failures gracefully', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockRejectedValue(new Error('S3 update failed'));
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should handle fingerprint update failures', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(false);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(console.log).toHaveBeenCalledWith('Fingerprint update failed, but continuing with other updates');
    });

    test('should handle S3 updateS3Data returning false', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockRejectedValue(new Error('S3 update failed'));
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(console.error).toHaveBeenCalledWith('Error updating S3 data:', expect.any(Error));
    });
  });

  describe('Successful approval flow', () => {
    test('should successfully approve and process sensor data', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

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
      
      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      expect(queryCall.args[0].input.TableName).toBe('test-temp-table');
      expect(queryCall.args[0].input.ExpressionAttributeValues[':PK']).toBe('GPCR');
      expect(queryCall.args[0].input.ExpressionAttributeValues[':SK']).toBe('P12345');
      
      const batchWriteCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'BatchWriteCommand');
      expect(batchWriteCalls.length).toBe(2);
      
      expect(mockUpdateMainIndex).toHaveBeenCalledWith(expect.any(Object), 'GPCR');
      expect(mockUpdateFamilyIndex).toHaveBeenCalledWith(expect.any(Object), 'GPCR');
      expect(mockSaveSensorFile).toHaveBeenCalledWith(expect.any(Object), 'GPCR');
      expect(mockUpdateAllSensorsGzip).toHaveBeenCalledWith(expect.any(Object), 'GPCR');
      expect(mockUpdateFingerprints).toHaveBeenCalledWith(expect.any(Object), 'GPCR');
    });

    test('should skip temp table deletion when SKIP_TEMP_DELETE is true', async () => {
      process.env.SKIP_TEMP_DELETE = 'true';
      
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

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
      
      const batchWriteCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'BatchWriteCommand');
      expect(batchWriteCalls.length).toBe(1);
    });
  });

  describe('Data formatting', () => {
    test('should format sensor data correctly with all categories', async () => {
      docClientMock.on(QueryCommand).resolves({ Items: mockSensorData });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

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

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      
      expect(formattedData.alias).toBe('TestSensor');
      expect(formattedData.family).toBe('GPCR');
      expect(formattedData.regulationType).toBe('positive');
      expect(formattedData.ligands).toHaveLength(1);
      expect(formattedData.operators).toHaveLength(1);
      expect(formattedData.structures).toEqual(['1ABC']);
      expect(formattedData.operon).toEqual(['gene1', 'gene2']);
      expect(formattedData.references).toHaveLength(3);
      expect(formattedData.fullReferences).toHaveLength(1);
    });

    test('should handle operon with newOperon data as string', async () => {
      const dataWithNewOperon = [
        ...mockSensorData.slice(0, -1),
        {
          PK: 'GPCR',
          SK: 'P12345#OPERON',
          category: 'operon',
          newOperon: {
            data: '["gene1", "gene2", "gene3"]'
          }
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: dataWithNewOperon });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      await handler(event);

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      expect(formattedData.newOperon).toEqual(['gene1', 'gene2', 'gene3']);
    });

    test('should handle operon with newOperon data as object', async () => {
      const dataWithNewOperon = [
        ...mockSensorData.slice(0, -1),
        {
          PK: 'GPCR',
          SK: 'P12345#OPERON',
          category: 'operon',
          newOperon: ['gene1', 'gene2', 'gene3']
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: dataWithNewOperon });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      await handler(event);

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      expect(formattedData.newOperon).toEqual(['gene1', 'gene2', 'gene3']);
    });

    test('should handle null arrays gracefully', async () => {
      const dataWithNulls = [
        {
          PK: 'GPCR',
          SK: 'P12345#ABOUT',
          category: 'about',
          alias: 'TestSensor',
          family: 'GPCR'
        },
        {
          PK: 'GPCR',
          SK: 'P12345#LIGANDS',
          category: 'ligands',
          ligands: null
        },
        {
          PK: 'GPCR',
          SK: 'P12345#OPERATOR',
          category: 'operator',
          operators: null
        },
        {
          PK: 'GPCR',
          SK: 'P12345#STRUCTURE',
          category: 'structure',
          data: null
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: dataWithNulls });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

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

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      expect(formattedData.ligands).toBeNull();
      expect(formattedData.operators).toBeNull();
      expect(formattedData.structures).toBeNull();
    });

    test('should handle structure data with fullDOI existing in fullRefSeen', async () => {
      const dataWithDuplicateFullDOI = [
        mockSensorData[0],
        {
          PK: 'GPCR',
          SK: 'P12345#STRUCTURE',
          category: 'structure',
          data: [
            {
              PDB_code: '1ABC',
              doi: '10.1234/structure',
              method: 'X-ray',
              ref_figure: 'Fig3',
              fullDOI: {
                title: 'Test Paper',
                authors: 'Test Author',
                year: 2023,
                journal: 'Test Journal',
                doi: '10.1234/duplicate',
                url: 'https://doi.org/10.1234/duplicate'
              }
            },
            {
              PDB_code: '2DEF',
              doi: '10.1234/structure2',
              method: 'NMR',
              ref_figure: 'Fig4',
              fullDOI: {
                title: 'Test Paper',
                authors: 'Test Author',
                year: 2023,
                journal: 'Test Journal',
                doi: '10.1234/duplicate',
                url: 'https://doi.org/10.1234/duplicate'
              }
            }
          ]
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: dataWithDuplicateFullDOI });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      await handler(event);

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      expect(formattedData.fullReferences).toHaveLength(1);
      expect(formattedData.fullReferences[0].interaction).toHaveLength(2);
    });

    test('should handle ligands with fullDOI existing in fullRefSeen', async () => {
      const dataWithDuplicateFullDOI = [
        mockSensorData[0],
        {
          PK: 'GPCR',
          SK: 'P12345#LIGANDS',
          category: 'ligands',
          ligands: [
            {
              name: 'TestLigand1',
              doi: '10.1234/ligand1',
              method: 'binding',
              ref_figure: 'Fig1A',
              fullDOI: {
                title: 'Test Paper',
                authors: 'Test Author',
                year: 2023,
                journal: 'Test Journal',
                doi: '10.1234/duplicate',
                url: 'https://doi.org/10.1234/duplicate'
              }
            },
            {
              name: 'TestLigand2',
              doi: '10.1234/ligand2',
              method: 'competition',
              ref_figure: 'Fig1B',
              fullDOI: {
                title: 'Test Paper',
                authors: 'Test Author',
                year: 2023,
                journal: 'Test Journal',
                doi: '10.1234/duplicate',
                url: 'https://doi.org/10.1234/duplicate'
              }
            }
          ]
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: dataWithDuplicateFullDOI });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      await handler(event);

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      expect(formattedData.fullReferences).toHaveLength(1);
      expect(formattedData.fullReferences[0].interaction).toHaveLength(2);
    });

    test('should handle operators with fullDOI existing in fullRefSeen', async () => {
      const dataWithDuplicateFullDOI = [
        mockSensorData[0], // about
        {
          PK: 'GPCR',
          SK: 'P12345#OPERATOR',
          category: 'operator',
          operators: [
            {
              sequence: 'ATCG',
              doi: '10.1234/operator1',
              method: 'EMSA',
              ref_figure: 'Fig2A',
              fullDOI: {
                title: 'Test Paper',
                authors: 'Test Author',
                year: 2023,
                journal: 'Test Journal',
                doi: '10.1234/duplicate',
                url: 'https://doi.org/10.1234/duplicate'
              }
            },
            {
              sequence: 'GCTA',
              doi: '10.1234/operator2',
              method: 'ChIP',
              ref_figure: 'Fig2B',
              fullDOI: {
                title: 'Test Paper',
                authors: 'Test Author',
                year: 2023,
                journal: 'Test Journal',
                doi: '10.1234/duplicate',
                url: 'https://doi.org/10.1234/duplicate'
              }
            }
          ]
        }
      ];

      docClientMock.on(QueryCommand).resolves({ Items: dataWithDuplicateFullDOI });
      docClientMock.on(BatchWriteCommand).resolves({});
      mockUpdateMainIndex.mockResolvedValue(true);
      mockUpdateFamilyIndex.mockResolvedValue(true);
      mockSaveSensorFile.mockResolvedValue(true);
      mockUpdateAllSensorsGzip.mockResolvedValue(true);
      mockUpdateFingerprints.mockResolvedValue(true);

      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'GPCR', uniProtID: 'P12345' })
      };

      await handler(event);

      const formattedData = mockUpdateMainIndex.mock.calls[0][0];
      expect(formattedData.fullReferences).toHaveLength(1);
      expect(formattedData.fullReferences[0].interaction).toHaveLength(2);
    });
  });
});
