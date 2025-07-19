import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CreateTableCommand } from "@aws-sdk/client-dynamodb";

// Initialize the DynamoDB client for local use
const dynamoClient = new DynamoDBClient({ 
  region: "local",
  endpoint: "http://localhost:8000"
});

async function createTables() {
  console.log("Creating tables in local DynamoDB instance...");
  
  // Table create commands
  const tables = [
    {
      TableName: "groov-api-table",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" }
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" }
      ],
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5
      }
    },
    {
      TableName: "groov-api-temp-table",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" }
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" }
      ],
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5
      }
    }
  ];

  // Create tables
  for (const tableParams of tables) {
    try {
      const command = new CreateTableCommand(tableParams);
      const response = await dynamoClient.send(command);
      console.log('Created table:', tableParams.TableName, response);
    } catch (err) {
      // Handle if table already exists
      if (err.name === 'ResourceInUseException') {
        console.log(`Table already exists: ${tableParams.TableName}`);
      } else {
        console.error('Error creating table:', tableParams.TableName, err);
      }
    }
  }
}

createTables()
  .then(() => console.log("Setup complete!"))
  .catch(err => console.error("Setup failed:", err)); 