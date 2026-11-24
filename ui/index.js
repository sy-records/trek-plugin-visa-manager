import {
  createTranslator,
  resolveLanguage,
  errorMessage,
} from "../server/i18n.js";
import { validate } from "../server/domain.js";

Object.assign(window, {
  visaI18n: { createTranslator, resolveLanguage, errorMessage },
  visaValidate: validate,
});
