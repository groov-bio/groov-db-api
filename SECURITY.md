# Security Policy

## Reporting Security Vulnerabilities

The GroovDB team takes security seriously. We appreciate your efforts to responsibly disclose your findings and will make every effort to acknowledge your contributions.

### How to Report a Security Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities by sending an email to:
**simon@groov.bio**

Include the following information in your report:

- Type of issue (e.g., SQL injection, cross-site scripting, authentication bypass, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

### What to Expect

After submitting a report, you will receive:

1. **Acknowledgment** within 48 hours confirming we received your report
2. **Initial Assessment** within 5 business days with our evaluation of the report
3. **Regular Updates** as we work on a fix
4. **Resolution Timeline** based on the severity and complexity of the issue

### Security Response Process

1. **Receipt & Triage** (0-5 days)
   - Acknowledge receipt of the vulnerability report
   - Assign severity level (Critical, High, Medium, Low)
   - Begin initial investigation

2. **Investigation** (1-14 days depending on severity)
   - Reproduce the vulnerability
   - Assess impact and scope
   - Develop fix or mitigation strategy

3. **Resolution** (varies by severity)
   - Implement and test fix
   - Prepare security advisory
   - Coordinate disclosure timeline

4. **Disclosure**
   - Release security patch
   - Publish security advisory
   - Credit reporter (if desired)

### Severity Guidelines

#### Critical
- Remote code execution in Lambda functions
- Authentication bypass allowing admin access
- SQL injection or NoSQL injection with data access
- Privilege escalation to admin level

#### High
- Cross-site scripting (XSS) with significant impact
- Significant data exposure (biosensor data, user information)
- Authentication issues without full bypass
- Unauthorized access to admin endpoints

#### Medium
- Cross-site request forgery (CSRF)
- Limited information disclosure
- Denial of service attacks
- Input validation bypasses

#### Low
- Minor information disclosure
- Issues requiring significant user interaction
- Non-exploitable code quality issues

### Security Best Practices

As an open source project, we follow these security practices:

#### Code Security
- Regular dependency updates and vulnerability scanning
- Code review requirements for all changes
- Automated security testing in CI/CD pipeline
- Input validation using Joi schemas
- Secure authentication and session management with AWS Cognito

#### Infrastructure Security
- HTTPS everywhere with proper certificate management
- AWS IAM with least privilege principles
- Secure API Gateway configuration with proper CORS
- Environment variables for sensitive configuration
- Regular security assessments

#### Data Security
- No sensitive data stored in the codebase
- API keys and secrets managed through AWS environment variables
- Database queries use AWS SDK with proper parameterization
- Data encrypted in transit and at rest via AWS services
- User authentication handled by AWS Cognito

### Supported Versions

We provide security updates for the following versions:

| Version        | Supported         |
| -------------- | ----------------- |
| Latest         | ✅ Yes            |
| Previous Major | ✅ Yes (6 months) |
| Older          | ❌ No             |

### Dependencies and Third-Party Security

We monitor security advisories for all dependencies and aim to:

- Update vulnerable dependencies within 7 days for critical issues
- Update vulnerable dependencies within 30 days for high-severity issues
- Regularly audit and update dependencies

Key security-related dependencies include:

**Node.js Dependencies:**
- `@aws-sdk/*` - AWS SDK for Lambda functions
- `aws-jwt-verify` - JWT token verification
- `joi` - Input validation

**Python Dependencies:**
- `boto3` - AWS SDK for Python
- `rdkit` - Molecular fingerprint generation

### Security Testing

We encourage responsible security testing of our application:

#### Allowed Testing
- Testing against your own local deployment
- Static analysis of this open source codebase
- Automated vulnerability scanning of your own instance

#### Prohibited Activities
- Testing against production groov.bio infrastructure without permission
- Social engineering attacks against GroovDB team members
- Denial of service attacks against any deployment
- Testing against user accounts you do not own
- Accessing or modifying data belonging to others
- Physical attacks against any infrastructure

### Vulnerability Disclosure Policy

#### Coordination
We prefer coordinated disclosure that gives us time to fix vulnerabilities before they are publicly disclosed. We will work with security researchers to:

- Understand the issue and its impact
- Develop and test a fix
- Agree on a disclosure timeline (typically 90 days)

#### Public Disclosure
Once a fix is available:
- We will publish a security advisory
- The researcher will be credited (if desired)
- Details will be shared to help users understand the risk

#### Recognition
We believe in recognizing security researchers who help improve our security:

- Public acknowledgment in security advisories (optional)
- Hall of fame on our security page
- Potential bounty rewards for significant findings (at our discretion)

### Security Resources

#### For Developers
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [AWS Security Best Practices](https://aws.amazon.com/architecture/security-identity-compliance/)

#### For Users
- Keep your deployment updated with latest releases
- Use strong, unique passwords for AWS accounts
- Enable AWS CloudTrail for audit logging
- Monitor AWS CloudWatch for suspicious activity
- Follow AWS security best practices for your deployment

### AWS-Specific Security Considerations

This project runs on AWS infrastructure. Additional security considerations:

#### Lambda Security
- Functions run with minimal IAM permissions
- VPC configuration when required
- Environment variable encryption
- Function-level dead letter queues for error handling

#### DynamoDB Security
- Encryption at rest enabled
- Access controlled via IAM policies
- Query patterns designed to prevent data leakage
- Regular backup and point-in-time recovery

#### API Gateway Security
- Request throttling and rate limiting
- Input validation at the gateway level
- CORS configuration for cross-origin requests
- Authorization using AWS Cognito or custom authorizers

### Contact Information

For security-related inquiries:

- **Email**: simon@groov.bio
- **General Contact**: Use the contact form at [groov.bio/contact](https://groov.bio/contact)
- **Non-security Issues**: Create a GitHub issue

### Legal Protection

GroovDB is committed to legal protection for security researchers:

- We will not pursue legal action against researchers who follow this policy
- We will work with researchers to understand and fix security issues
- We will not pursue legal action for security research conducted in good faith

---

**Note**: This security policy is inspired by industry best practices and may be updated as our security posture evolves. Check back regularly for updates.

Last updated: July 19, 2025