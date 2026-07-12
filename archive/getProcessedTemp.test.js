import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getProcessedTemp/getProcessedTemp.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('GetProcessedTemp Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockAboutData = {
    PK: 'GPCR',
    SK: 'P12345#ABOUT',
    category: 'about',
    alias: 'TestSensor1',
    family: 'GPCR',
    uniprotID: 'P12345',
    mechanism: 'activation',
    description: 'Test sensor description'
  };

  const mockLigandsData = {
    PK: 'GPCR',
    SK: 'P12345#LIGANDS',
    category: 'ligands',
    ligands: [
      {
        name: 'Ligand1',
        doi: '10.1000/test1',
        ref_figure: 'Figure 1',
        method: 'FRET',
        fullDOI: {
          title: 'Test Paper 1',
          authors: 'Smith et al.',
          year: 2023,
          journal: 'Nature',
          doi: '10.1000/test1',
          url: 'https://doi.org/10.1000/test1'
        }
      }
    ]
  };

  const mockOperatorData = {
    PK: 'GPCR',
    SK: 'P12345#OPERATOR',
    category: 'operator',
    operators: [
      {
        name: 'Operator1',
        doi: '10.1000/test2',
        ref_figure: 'Figure 2',
        method: 'ChIP-seq',
        fullDOI: {
          title: 'Test Paper 2',
          authors: 'Jones et al.',
          year: 2022,
          journal: 'Cell',
          doi: '10.1000/test2',
          url: 'https://doi.org/10.1000/test2'
        }
      }
    ]
  };

  const mockStructureData = {
    PK: 'GPCR',
    SK: 'P12345#STRUCTURE',
    category: 'structure',
    data: [
      {
        PDB_code: '1ABC',
        doi: '10.1000/test3',
        ref_figure: 'Figure 3',
        method: 'X-ray',
        fullDOI: {
          title: 'Test Paper 3',
          authors: 'Brown et al.',
          year: 2021,
          journal: 'Science',
          doi: '10.1000/test3',
          url: 'https://doi.org/10.1000/test3'
        }
      }
    ]
  };

  const mockOperonData = {
    PK: 'GPCR',
    SK: 'P12345#OPERON',
    category: 'operon',
    newOperon: {
      data: JSON.stringify({ genes: ['gene1', 'gene2'], promoter: 'prom1' })
    }
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
      expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://www.groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use allowed origin for localhost', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'http://localhost:3000'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin for disallowed origins', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin when no origin header provided', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {},
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Query parameter handling', () => {
    test('should use correct query parameters in DynamoDB query', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      const queryParams = queryCall.args[0].input;
      
      expect(queryParams.TableName).toBe('test-temp-table');
      expect(queryParams.KeyConditionExpression).toBe('PK = :PK AND begins_with( SK, :SK )');
      expect(queryParams.ExpressionAttributeValues).toEqual({
        ':PK': 'GPCR',
        ':SK': 'P12345'
      });
    });

    test('should handle different family types', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [{ ...mockAboutData, PK: 'KINASE', family: 'KINASE' }]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P67890',
          family: 'KINASE'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      const queryParams = queryCall.args[0].input;
      
      expect(queryParams.ExpressionAttributeValues[':PK']).toBe('KINASE');
      expect(queryParams.ExpressionAttributeValues[':SK']).toBe('P67890');
    });
  });

  describe('Data formatting', () => {
    describe('About category', () => {
      test('should format about data correctly', async () => {
        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        
        expect(body.alias).toBe('TestSensor1');
        expect(body.family).toBe('GPCR');
        expect(body.uniprotID).toBe('P12345');
        expect(body.regulationType).toBe('activation');
        expect(body.description).toBe('Test sensor description');
        expect(body).not.toHaveProperty('PK');
        expect(body).not.toHaveProperty('SK');
        expect(body).not.toHaveProperty('category');
      });

      test('should handle about data without mechanism', async () => {
        const aboutDataNoMechanism = { ...mockAboutData };
        delete aboutDataNoMechanism.mechanism;

        docClientMock.on(QueryCommand).resolves({ 
          Items: [aboutDataNoMechanism]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.regulationType).toBe('');
      });
    });

    describe('Ligands category', () => {
      test('should format ligands data correctly', async () => {
        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, mockLigandsData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        
        expect(body.ligands).toHaveLength(1);
        expect(body.ligands[0].name).toBe('Ligand1');
        expect(body.references).toContainEqual({
          doi: '10.1000/test1',
          figure: 'Figure 1',
          interaction: 'Ligand',
          method: 'FRET'
        });
        expect(body.fullReferences).toHaveLength(1);
        expect(body.fullReferences[0].title).toBe('Test Paper 1');
      });

      test('should handle null ligands array', async () => {
        const nullLigandsData = {
          ...mockLigandsData,
          ligands: null
        };

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, nullLigandsData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.ligands).toBeNull();
      });

      test('should handle missing ligands array', async () => {
        const missingLigandsData = { ...mockLigandsData };
        delete missingLigandsData.ligands;

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, missingLigandsData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.ligands).toBeNull();
      });
    });

    describe('Operators category', () => {
      test('should format operators data correctly', async () => {
        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, mockOperatorData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        
        expect(body.operators).toHaveLength(1);
        expect(body.operators[0].name).toBe('Operator1');
        expect(body.references).toContainEqual({
          doi: '10.1000/test2',
          figure: 'Figure 2',
          interaction: 'Operator',
          method: 'ChIP-seq'
        });
      });

      test('should handle null operators array', async () => {
        const nullOperatorsData = {
          ...mockOperatorData,
          operators: null
        };

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, nullOperatorsData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.operators).toBeNull();
      });
    });

    describe('Structure category', () => {
      test('should format structure data correctly', async () => {
        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, mockStructureData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        
        expect(body.structures).toEqual(['1ABC']);
        expect(body.references).toContainEqual({
          doi: '10.1000/test3',
          figure: 'Figure 3',
          interaction: 'Structure',
          method: 'X-ray'
        });
      });

      test('should handle null structure data array', async () => {
        const nullStructureData = {
          ...mockStructureData,
          data: null
        };

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, nullStructureData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.structures).toBeNull();
      });
    });

    describe('Operon category', () => {
      test('should format operon data correctly', async () => {
        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, mockOperonData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        
        expect(body.newOperon).toEqual({
          genes: ['gene1', 'gene2'],
          promoter: 'prom1'
        });
      });

      test('should handle invalid JSON in operon data', async () => {
        const invalidOperonData = {
          ...mockOperonData,
          newOperon: {
            data: 'invalid json{'
          }
        };

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, invalidOperonData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.newOperon).toBeNull();
      });

      test('should handle missing operon data', async () => {
        const missingOperonData = {
          ...mockOperonData,
          newOperon: {}
        };

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, missingOperonData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.newOperon).toBeNull();
      });
    });

    describe('Full reference handling', () => {
      test('should merge duplicate DOIs in full references', async () => {
        const duplicateLigandsData = {
          ...mockLigandsData,
          ligands: [
            {
              name: 'Ligand1',
              doi: '10.1000/test1',
              ref_figure: 'Figure 1A',
              method: 'FRET',
              fullDOI: {
                title: 'Test Paper 1',
                authors: 'Smith et al.',
                year: 2023,
                journal: 'Nature',
                doi: '10.1000/test1',
                url: 'https://doi.org/10.1000/test1'
              }
            },
            {
              name: 'Ligand2',
              doi: '10.1000/test1',
              ref_figure: 'Figure 1B',
              method: 'BRET',
              fullDOI: {
                title: 'Test Paper 1',
                authors: 'Smith et al.',
                year: 2023,
                journal: 'Nature',
                doi: '10.1000/test1',
                url: 'https://doi.org/10.1000/test1'
              }
            }
          ]
        };

        docClientMock.on(QueryCommand).resolves({ 
          Items: [mockAboutData, duplicateLigandsData]
        });

        const event = {
          requestContext: {
            http: {
              method: 'GET'
            }
          },
          headers: {
            origin: 'https://groov.bio'
          },
          queryStringParameters: {
            sensorID: 'P12345',
            family: 'GPCR'
          }
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        
        expect(body.fullReferences).toHaveLength(1);
        expect(body.fullReferences[0].interaction).toHaveLength(2);
        expect(body.fullReferences[0].interaction[0].method).toBe('FRET');
        expect(body.fullReferences[0].interaction[1].method).toBe('BRET');
      });
    });

    test('should handle complete sensor data with all categories', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData, mockLigandsData, mockOperatorData, mockStructureData, mockOperonData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      
      // Check all categories are present
      expect(body.alias).toBe('TestSensor1');
      expect(body.ligands).toHaveLength(1);
      expect(body.operators).toHaveLength(1);
      expect(body.structures).toEqual(['1ABC']);
      expect(body.newOperon).toEqual({ genes: ['gene1', 'gene2'], promoter: 'prom1' });
      
      // Check references
      expect(body.references).toHaveLength(3);
      expect(body.fullReferences).toHaveLength(3);
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB query error', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('DynamoDB query failed'));

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error on getting processed temp, please check logs');
      expect(console.log).toHaveBeenCalledWith(expect.any(Error));
    });

    test('should handle DynamoDB access denied error', async () => {
      const accessDeniedError = new Error('User is not authorized to perform: dynamodb:Query');
      accessDeniedError.name = 'AccessDeniedException';
      
      docClientMock.on(QueryCommand).rejects(accessDeniedError);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error on getting processed temp, please check logs');
    });

    test('should handle DynamoDB throttling error', async () => {
      const throttlingError = new Error('Throughput exceeds the current capacity');
      throttlingError.name = 'ProvisionedThroughputExceededException';
      
      docClientMock.on(QueryCommand).rejects(throttlingError);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error on getting processed temp, please check logs');
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table name from environment variable', async () => {
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';
      
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      expect(queryCall.args[0].input.TableName).toBe('custom-temp-table');
    });

    test('should handle missing environment variable gracefully', async () => {
      delete process.env.TEMP_TABLE_NAME;
      
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      expect(queryCall.args[0].input.TableName).toBeUndefined();
    });
  });

  describe('Response structure', () => {
    test('should return correct response structure for successful request', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).toHaveProperty('body');
      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Credentials');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Headers');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Methods');
      expect(result.headers).toHaveProperty('Access-Control-Max-Age');
    });

    test('should return correct response structure for error', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('Test error'));

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).toHaveProperty('body');
      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('message');
    });

    test('should return correct response structure for OPTIONS request', async () => {
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

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).not.toHaveProperty('body');
      expect(result.statusCode).toBe(200);
    });
  });

  describe('Request method handling', () => {
    test('should handle GET request correctly', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(docClientMock.calls()).toHaveLength(1);
    });

    test('should handle request without requestContext', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.alias).toBe('TestSensor1');
    });

    test('should handle request without http method', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [mockAboutData]
      });

      const event = {
        requestContext: {},
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorID: 'P12345',
          family: 'GPCR'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.alias).toBe('TestSensor1');
    });
  });
});
