# Cert Prep Privacy Notice

Cert Prep is a local-first desktop application. Imported PDFs, extracted text,
generated questions, practice attempts, and the application database stay on
the user's Windows device. Cert Prep does not provide an account service,
upload document contents to a Cert Prep server, or send product analytics.

Network access is used only when the user explicitly installs or updates a
runtime or model, or downloads a release artifact. Depending on the selected
runtime, requests may reach GitHub Releases, Ollama distribution/model
endpoints, or model hosting endpoints used by those third-party tools. Those
services receive ordinary connection
metadata such as the user's IP address, but Cert Prep does not send PDF text or
practice answers with those downloads.

Application data remains in the local app-data directory until the user
deletes the relevant project/data or uninstalls and removes local data. Local
diagnostic logs and release evidence must not contain PDF contents, access
tokens, prompts, generated answers, or other response secrets.

For alpha support or privacy questions, use the public repository's GitHub
Issues page. This notice applies to the public unsigned alpha and will be
reviewed before any telemetry, cloud sync, account, or remote inference feature
is introduced.
