// Owner: frontend-engineer. Shapes for the secondary menu language (English is always primary on /menu).
import type { MenuLanguage } from "@/types/contract";
import type { MenuUiKey } from "./keys";

export type { MenuUiKey };

/** Menu language mode: English only ("none"), or English plus ONE secondary language. */
export type MenuLang = "none" | MenuLanguage;

/** One language's UI strings, keyed like the translator file. Tokens such as {n} are filled by `fill()`. */
export type MenuUiPack = Record<MenuUiKey, string>;
