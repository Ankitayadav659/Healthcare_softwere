# Dr. Pallavi Chogale Physiotherapy Clinic

A Windows-only, single-computer clinic application with patient profiles, appointments, session history, attendance, follow-up reminders, fees, payments and printable receipts. Patient, visit, payment and clinic data is saved by a local Python/SQLite backend instead of browser local storage.

This first product is intentionally for one clinic at a time. **Clinic settings** can change the clinic display/invoice names, provider title, specialty wording, visit labels/description, and one of three accent colors. This makes the physiotherapy-first interface easier to tailor, but changing labels is not the same as implementing or validating dental, general-practice, diagnostic, or other specialty workflows.

## Start the clinic app

1. Install current Python 3 for Windows if `py -3` is not already available.
2. Double-click **Start Clinic.bat** and keep its black server window open while using the app.
3. The clinic app opens at `http://127.0.0.1:8765`.
4. On first launch, create the clinic owner account. Use a unique passphrase of at least 14 characters and keep it safe; there is no password-reset flow.
5. Use **Clinic settings** to enter the clinic's correct invoice details.
6. In **Clinic settings**, personalize the app display name, specialty and provider information. Keep the visit labels truthful to the clinic's real workflow.

No Python packages or internet connection are required for the local backend. The browser may use the existing Google Fonts link when internet is available; patient records are not sent to that service.

The earlier `file://` browser-demo data is not imported into the server database; the new database starts empty. Use only the URL opened by **Start Clinic.bat**, not the old direct `index.html` browser tab.

## Data protection and backups

- The server listens only on this computer's loopback address; it is not exposed to the clinic network or internet.
- The database is stored under `%LOCALAPPDATA%\PallaviPhysio\clinic.db`. Patient/visit/clinic records are protected using Windows DPAPI for the current Windows user and machine. Passwords are stored as salted scrypt hashes, not plaintext.
- The app requires sign-in, uses an HttpOnly/SameSite session cookie, CSRF checks, login throttling, idle locking, server-side record validation, revision checks, and a metadata-only audit log.
- A daily database snapshot is kept under `%LOCALAPPDATA%\PallaviPhysio\backups`; **Download encrypted backup** downloads a protected SQLite copy. The protected data can only be decrypted under the same Windows account/profile on the same computer. Keep the computer and any backup files physically protected.
- Turn on Windows device encryption/BitLocker, use a private Windows login with a strong password, install security updates, and do not leave the clinic app unlocked or share the Windows account.

## Important limits before real patient use

This is a local single-computer application, not a hosted cloud service: there is no access from a phone or another computer, no off-site disaster-recovery backup, no staff roles, no HTTPS remote access, no automatic WhatsApp sending, and no independent security or legal compliance certification. DPAPI protects stored records from casual/offline file reading but does not protect against malware or a person already logged into the same Windows account. Losing the Windows profile/device can make the database and downloaded encrypted backups unrecoverable.

The clinic owner remains responsible for patient consent, access procedures, secure device/backup handling, record retention, and applicable Indian privacy/healthcare requirements. Have the workflow reviewed before entering real health information. Do not expose the backend port to the network or internet. For multiple devices, staff accounts, remote access or reliable off-site backups, use a properly managed provider with suitable contractual/privacy safeguards and professional security review; a free tier should not be assumed suitable for identifiable health information.

## WhatsApp and receipts

WhatsApp actions open a pre-filled message for staff review; they do not send automatically. Receipts are generated from the entered clinic and payment details. Confirm the clinic's accounting/tax requirements before treating them as tax invoices.
