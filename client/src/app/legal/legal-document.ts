import { Language } from '../shared/i18n/i18n';
import * as en from './texts/en';
import * as uk from './texts/uk';

/** Умови користування чи політика конфіденційності. */
export type LegalKind = 'terms' | 'privacy';

/** Абзац — рядок, список — масив рядків. */
export type LegalBlock = string | readonly string[];

export interface LegalSection {
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

/**
 * Юридичний документ. Кожною мовою він написаний окремо (texts/uk.ts, texts/en.ts), а не перекладається
 * по рядках через словник: важить точність формулювань, а не збіг фраз.
 */
export interface LegalDocument {
  readonly title: string;
  /** «Редакція від …» — коли документ востаннє змінено. */
  readonly updated: string;
  readonly intro: readonly LegalBlock[];
  readonly sections: readonly LegalSection[];
}

const DOCUMENTS: Readonly<Record<Language, Readonly<Record<LegalKind, LegalDocument>>>> = {
  uk: { terms: uk.TERMS, privacy: uk.PRIVACY },
  en: { terms: en.TERMS, privacy: en.PRIVACY },
};

export function legalDocument(kind: LegalKind, language: Language): LegalDocument {
  return DOCUMENTS[language][kind];
}
