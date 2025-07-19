# Contributing to GroovDB API

Thank you for your interest in contributing to the GroovDB API! This document provides guidelines and information for contributors.

## Code of Conduct

We are committed to providing a welcoming and inclusive environment for all contributors. By participating in this project, you agree to abide by our code of conduct:

- Be respectful and inclusive in all interactions
- Focus on constructive feedback and collaboration
- Respect differing viewpoints and experiences
- Show empathy towards other community members
- Use welcoming and inclusive language

## How to Contribute

### Reporting Issues

Before creating an issue, please:

1. **Search existing issues** to avoid duplicates
2. **Use a clear, descriptive title** that summarizes the problem
3. **Provide detailed information** including:
   - Steps to reproduce the issue
   - Expected vs. actual behavior
   - AWS/Node.js/Python version details
   - Relevant logs or error messages
   - Your deployment environment (local, AWS, etc.)

### Types of Contributions

We welcome several types of contributions:

#### 🐛 Bug Reports
- API endpoint issues
- Lambda function errors
- Database connectivity problems
- Performance issues
- Documentation errors

#### 💡 Feature Requests
- New API endpoints
- Enhanced search capabilities
- Data export improvements
- Security enhancements
- Developer experience improvements

#### 📊 Data Contributions
- New biosensor data formats
- Improved data validation
- Database schema enhancements
- Data migration tools

#### 📚 Documentation
- README improvements
- Code comments
- API documentation
- Deployment guides
- Tutorial content

#### 🔧 Code Contributions
- Bug fixes
- New features
- Performance optimizations
- Test improvements
- Infrastructure enhancements

## Development Workflow

### Prerequisites

- Node.js 20 or higher
- Python 3.12 or higher
- AWS CLI configured
- AWS SAM CLI
- Docker Desktop
- Git

### Setting Up Development Environment

```bash
# Fork the repository on GitHub
# Clone your fork
git clone https://github.com/YOUR-USERNAME/groov-db-api.git
cd groov-db-api

# Add upstream remote
git remote add upstream https://github.com/original-org/groov-db-api.git

# Install dependencies
npm install
cd layers/node && npm install && cd ../..
cd layers/python && pip3 install -r requirements.txt -t ./python && cd ../..
cd scripts && npm install && cd ..

# Set up local environment
chmod +x ./setup-local-complete.sh
./setup-local-complete.sh
```

### Making Changes

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow the coding standards (see below)
   - Add tests for new functionality
   - Update documentation as needed
   - Ensure your changes work with both local and AWS deployments

3. **Test your changes**
   ```bash
   # Run unit tests
   npm test

   # Test specific function
   npm test -- --testNamePattern="functionName"

   # Run local API
   sam local start-api --env-vars .env.json
   
   # Test endpoints with Bruno or curl
   ```

4. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add new biosensor validation endpoint"
   ```

### Commit Message Guidelines

Use conventional commit format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks
- `perf:` - Performance improvements
- `ci:` - CI/CD changes

Examples:
```
feat: add ligand similarity search endpoint
fix: resolve DynamoDB connection timeout issue
docs: update API endpoint documentation
test: add tests for search function
perf: optimize fingerprint generation algorithm
```

### Pull Request Process

This project follows a two-stage deployment process: **stage** → **main**

#### For New Features and Bug Fixes

1. **Update your branch with latest upstream changes**
   ```bash
   git fetch upstream
   git rebase upstream/stage  # Note: rebase from stage, not main
   ```

2. **Push your branch**
   ```bash
   git push origin feature/your-feature-name
   ```

3. **Create a Pull Request to `stage` branch**
   - Target the `stage` branch (not `main`)
   - Use the provided PR template
   - Use a clear, descriptive title
   - Reference any related issues
   - Provide detailed description of changes
   - Include test coverage information

4. **After merge to `stage`**
   - GitHub Actions automatically deploys to staging environment
   - Test your changes in staging
   - Verify everything works as expected

5. **Create Production Release PR**
   - Once tested in staging, create a PR from `stage` to `main`
   - Include release notes and summary of changes
   - After review and approval, merge to `main` for production deployment

#### For Hotfixes (Emergency Production Fixes)

1. **Branch from `main`** for critical production issues
   ```bash
   git checkout main
   git pull upstream main
   git checkout -b hotfix/critical-issue-name
   ```

2. **Create PR directly to `main`** with clear justification
3. **After production deployment, backport to `stage`**

#### Branch Strategy Summary

- **Feature branches** → **`stage`** → **`main`**
- **Hotfix branches** → **`main`** (then backport to `stage`)
- All changes should go through staging first unless it's a critical hotfix

#### Address Feedback

- Respond to reviewer comments
- Make requested changes
- Push updates to your branch

## Coding Standards

### JavaScript/Node.js

- Use ES modules (`import`/`export` syntax)
- Follow functional programming patterns where appropriate
- Use meaningful variable and function names
- Add JSDoc comments for public functions
- Use `async/await` instead of callbacks or raw promises

```javascript
// Good
/**
 * Retrieves a biosensor by its UniProt ID
 * @param {string} uniprotId - The UniProt identifier
 * @returns {Promise<Object>} The biosensor data
 */
export const getSensorByUniprotId = async (uniprotId) => {
  const params = {
    TableName: process.env.TABLE_NAME,
    Key: { uniprotID: uniprotId }
  };
  
  const result = await dynamoClient.send(new GetCommand(params));
  return result.Item;
};
```

### Python

- Follow PEP 8 style guidelines
- Use type hints where appropriate
- Add docstrings for functions and classes
- Use meaningful variable names
- Handle exceptions appropriately

```python
# Good
def generate_morgan_fingerprint(smiles: str, radius: int = 2, n_bits: int = 2048) -> bytes:
    """
    Generate Morgan fingerprint for a given SMILES string.
    
    Args:
        smiles: SMILES representation of the molecule
        radius: Radius for Morgan fingerprint
        n_bits: Number of bits for fingerprint
        
    Returns:
        Serialized fingerprint as bytes
        
    Raises:
        ValueError: If SMILES string is invalid
    """
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"Invalid SMILES string: {smiles}")
    
    fingerprint = morgan_generator.GetFingerprint(mol)
    return pickle.dumps(fingerprint)
```

### AWS Lambda Functions

- Keep functions focused and single-purpose
- Use proper error handling and logging
- Validate inputs using Joi schemas
- Return consistent response formats
- Include CORS headers for API endpoints

```javascript
// Good Lambda handler structure
export const handler = async (event, context) => {
  const logger = createLogger(context.requestId);
  
  try {
    // Input validation
    const { error, value } = schema.validate(event.queryStringParameters);
    if (error) {
      return createErrorResponse(400, 'Invalid input parameters');
    }
    
    // Business logic
    const result = await processRequest(value);
    
    // Success response
    return createSuccessResponse(result);
    
  } catch (error) {
    logger.error('Function execution failed', { error: error.message });
    return createErrorResponse(500, 'Internal server error');
  }
};
```

### Testing

- Write unit tests for all new functions
- Use descriptive test names
- Test both success and error cases
- Mock external dependencies (AWS services, etc.)
- Aim for meaningful test coverage

```javascript
// Good test structure
import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getSensor } from '../getSensor.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('getSensor', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('should return sensor data for valid uniprotID', async () => {
    const mockSensor = { uniprotID: 'P12345', name: 'Test Sensor' };
    ddbMock.on(GetCommand).resolves({ Item: mockSensor });

    const event = {
      queryStringParameters: { uniprotID: 'P12345' }
    };

    const result = await handler(event, {});
    
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(mockSensor);
  });

  it('should return 404 for non-existent sensor', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = {
      queryStringParameters: { uniprotID: 'INVALID' }
    };

    const result = await handler(event, {});
    
    expect(result.statusCode).toBe(404);
  });
});
```

### File Organization

- Place Lambda functions in `functions/` directory
- Each function should have its own directory
- Include function-specific `package.json` if needed
- Use descriptive file and directory names
- Keep utility functions in `utils/` subdirectories

### Documentation

- Update README.md for new features
- Document new API endpoints
- Include code examples where helpful
- Update the API documentation in `functions/docs/swagger.yaml`

## API Design Guidelines

### Endpoint Design

- Use RESTful conventions where appropriate
- Use clear, descriptive endpoint names
- Include proper HTTP status codes
- Support CORS for browser access
- Include pagination for large datasets

### Request/Response Format

- Use JSON for request and response bodies
- Include proper Content-Type headers
- Validate all input parameters
- Return consistent error response format

```javascript
// Standard error response format
{
  "error": {
    "message": "Validation failed",
    "code": "VALIDATION_ERROR",
    "details": ["uniprotID is required"]
  }
}

// Standard success response format
{
  "data": {
    // Response data here
  },
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1000
  }
}
```

## Database Guidelines

### DynamoDB Best Practices

- Design efficient partition and sort keys
- Use sparse indexes where appropriate
- Minimize the number of requests
- Handle throttling gracefully
- Use consistent read operations when needed

### Data Validation

- Validate all data before writing to database
- Use Joi schemas for input validation
- Sanitize user input appropriately
- Handle malformed data gracefully

## Security Guidelines

### Input Validation

- Validate all user inputs
- Use parameterized queries
- Sanitize data before processing
- Implement rate limiting where appropriate

### Authentication & Authorization

- Use AWS Cognito for user authentication
- Implement proper authorization checks
- Use IAM roles with least privilege
- Never commit secrets to the repository

### Error Handling

- Don't expose sensitive information in error messages
- Log security-relevant events
- Handle errors gracefully
- Use appropriate HTTP status codes

## Performance Guidelines

### Lambda Optimization

- Minimize cold start times
- Use ARM64 architecture where supported
- Optimize memory allocation
- Reuse connections and clients

### Database Optimization

- Design efficient query patterns
- Use appropriate indexes
- Implement caching where beneficial
- Monitor performance metrics

## Deployment Guidelines

### Local Testing

- Test all changes locally before deploying
- Use the provided setup scripts
- Test with sample data
- Verify all endpoints work correctly

### AWS Deployment

- Use Infrastructure as Code (SAM templates)
- Test in staging environment first
- Monitor CloudWatch logs and metrics
- Use the stage → main deployment flow

## Release Process

### Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- `MAJOR.MINOR.PATCH`
- Major: Breaking changes
- Minor: New features (backward compatible)
- Patch: Bug fixes (backward compatible)

### Release Schedule

- Patch releases: As needed for critical fixes
- Minor releases: Monthly for new features
- Major releases: Annually or for significant changes

## Getting Help

### Documentation

- **API Documentation**: Available via `/swagger` endpoint
- **AWS SAM Docs**: [AWS SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/)
- **Code Comments**: Inline documentation in source code

### Communication

- **GitHub Issues**: For bug reports and feature requests
- **GitHub Discussions**: For questions and general discussion
- **Contact Form**: [groov.bio/contact](https://groov.bio/contact)

### Development Setup Issues

If you encounter problems setting up the development environment:

1. Check the troubleshooting section in README.md
2. Search existing issues for similar problems
3. Create a new issue with:
   - Your operating system and version
   - Node.js, Python, and AWS CLI versions
   - Complete error messages
   - Steps you've already tried

## Recognition

Contributors will be recognized in several ways:

- **Contributors List**: Listed in repository contributors
- **Changelog**: Mentioned in release notes
- **Code Comments**: Significant contributions acknowledged in code
- **Publications**: Major contributors may be included in academic publications

## Questions?

Don't hesitate to ask questions! We're here to help new contributors get started. The best ways to get help are:

1. Check existing documentation and issues
2. Create a GitHub issue for specific problems
3. Use the contact form for general questions

Thank you for contributing to GroovDB API and advancing synthetic biology research! 🧬