import {
  createTranslator,
  resolveLanguage,
  errorMessage,
} from "../server/i18n.js";
import { validate } from "../server/domain.js";
import { REGION_CODES } from "../server/regions.js";

Object.assign(window, {
  visaI18n: { createTranslator, resolveLanguage, errorMessage },
  visaValidate: validate,
  visaRegionCodes: REGION_CODES,
});
