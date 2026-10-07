import { qualifyCredentialStateModel } from "../test/fixtures/smart-http-state-model.ts";

console.log(JSON.stringify(await qualifyCredentialStateModel(), null, 2));
