import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DatePickerView } from "../../../client/src/components/shared/DatePickerView";
import { localIsoDate } from "../../../client/src/utils/localDate";
import commonZh from "../../../shared/src/i18n/zh/common";
import commonEn from "../../../shared/src/i18n/en/common";
import {
  createTranslator,
  resolveLanguage,
  errorMessage,
} from "../server/i18n";
import { validate } from "../server/domain";

interface DateFieldOptions {
  name: string;
  label: string;
  language: string;
  value: string;
  required: boolean;
  min: string;
  max: string;
  portalContainer: HTMLElement;
  onInvalid: (message: string) => void;
}

function DateField({
  name,
  label,
  language,
  value: initialValue,
  required,
  min,
  max,
  portalContainer,
  onInvalid,
}: DateFieldOptions) {
  const t = createTranslator(language);
  const common = resolveLanguage(language) === "zh-CN" ? commonZh : commonEn;
  const [value, setValue] = useState(initialValue);
  const updateValue = (next: string) => {
    if (next) {
      const parsed = new Date(`${next}T00:00:00Z`);
      if (
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== next
      ) {
        onInvalid(t("errors.invalidDate", { field: label }));
        return;
      }
    }
    setValue(next);
  };
  return (
    <>
      <input
        className="date-value"
        type="date"
        id={`field-${name}`}
        name={name}
        value={value}
        required={required}
        min={min}
        max={max}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => updateValue(event.target.value)}
        onFocus={(event) => {
          event.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>("button")
            ?.focus();
        }}
        onInvalid={(event) => {
          event.preventDefault();
          onInvalid(t("errors.required", { field: label }));
          event.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>("button")
            ?.focus();
        }}
      />
      <DatePickerView
        value={value}
        onChange={updateValue}
        ariaLabel={label}
        placeholder={t("date.select", { field: label })}
        locale={resolveLanguage(language)}
        t={(key) => common[key] ?? commonEn[key] ?? key}
        weekStart={1}
        dateFormat="YYYY-MM-DD"
        min={min}
        max={max}
        portalContainer={portalContainer}
        initialViewDate={localIsoDate()}
      />
    </>
  );
}

function mountDatePicker(container: HTMLElement, options: DateFieldOptions) {
  const root = createRoot(container);
  // The form is assembled synchronously before showModal() and validity checks.
  flushSync(() => root.render(<DateField {...options} />));
  return () => root.unmount();
}

Object.assign(window, {
  visaDatePicker: { mount: mountDatePicker },
  visaI18n: { createTranslator, resolveLanguage, errorMessage },
  visaValidate: validate,
});
