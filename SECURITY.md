Security Policy

Thank you for helping improve the security of Stenograma.

Stenograma is an open-source, self-hosted application for AI-assisted meeting transcription and protocol generation. Responsible disclosure helps protect all users of the project.

---

Supported Versions

Security fixes are applied to the latest maintained version of the project.

Version| Supported
Latest maintained version| ✅
Older versions| ❌

---

Reporting a Vulnerability

If you discover a potential security vulnerability, please do not report it through a public GitHub issue.

If GitHub Private Vulnerability Reporting is enabled for this repository, please use it. Otherwise, contact the project maintainer privately at juliana.vorono@gmail.com.

When reporting a vulnerability, please include:

- a description of the issue;
- steps to reproduce;
- affected component(s);
- potential impact;
- proof of concept (if available).

The maintainer will make a reasonable effort to acknowledge valid reports promptly, investigate the issue, and prepare a fix where appropriate.

Please avoid public disclosure until a fix has been released or a mutually agreed disclosure timeline has passed.

---

Scope

This policy applies to vulnerabilities affecting the Stenograma codebase, including:

- backend services;
- frontend application;
- worker processes;
- provider implementations;
- deployment scripts;
- Docker-based deployments;
- configuration handling.

This policy does not cover vulnerabilities originating solely from third-party software or services that are unrelated to this project's code or configuration, including external AI providers, operating systems, container runtimes, or cloud platforms.

---

Privacy Considerations

Stenograma processes user-provided audio and may generate transcripts, summaries and meeting protocols.

Depending on deployment configuration, data may be processed:

- locally;
- on self-hosted infrastructure;
- by third-party AI providers selected by the administrator.

Users and administrators are responsible for evaluating whether their deployment complies with applicable privacy and data protection regulations (such as GDPR).

---

Deployment Security

For production deployments, it is recommended to:

- enable an authentication mechanism (such as "API_KEY" or an equivalent solution);
- never expose development mode to the public Internet;
- store secrets securely using environment variables or a dedicated secret-management solution;
- use HTTPS for externally accessible deployments;
- restrict access to internal AI services whenever possible;
- rotate credentials if they are suspected to be compromised.

---

Responsible Disclosure

Security research conducted in good faith is appreciated.

Please do not intentionally:

- disrupt services;
- access data that does not belong to you;
- modify or destroy data;
- violate applicable laws or regulations.

Confirmed security vulnerabilities may be documented in future release notes.

Thank you for helping improve the security of Stenograma.
