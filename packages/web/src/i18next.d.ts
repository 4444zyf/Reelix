import "i18next";
import type activity from "./locales/en/activity.json";
import type appearance from "./locales/en/appearance.json";
import type chat from "./locales/en/chat.json";
import type common from "./locales/en/common.json";
import type doctor from "./locales/en/doctor.json";
import type library from "./locales/en/library.json";
import type media from "./locales/en/media.json";
import type models from "./locales/en/models.json";
import type nav from "./locales/en/nav.json";
import type settings from "./locales/en/settings.json";

/** Keys are checked against the English files. */
declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "common";
		returnNull: false;
		resources: { common: typeof common; nav: typeof nav; appearance: typeof appearance; chat: typeof chat; media: typeof media; library: typeof library; settings: typeof settings; activity: typeof activity; doctor: typeof doctor; models: typeof models };
	}
}
