import {
  CUSTOMER_REALM_INSTALLATION_MANIFEST,
  customerRealmInstallationManifestDigest,
} from "../src/cloudflare/realm-operator.ts";

const digest = await customerRealmInstallationManifestDigest();
console.log(JSON.stringify({
  manifest: CUSTOMER_REALM_INSTALLATION_MANIFEST,
  digest,
  receipt: "manifest=versioned; digest=sha256; credentialFree=true; mutation=not-performed",
}, null, 2));
