// Consent decisions made in the members area, into public.consent_records (TECH_DEBT #1). The handler: netlify/lib/consent-log.mjs.
import { consentLog, realDeps } from '../lib/consent-log.mjs';

export default consentLog(realDeps());
