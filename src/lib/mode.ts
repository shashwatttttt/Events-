import "server-only";
import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
export async function isEffectiveTestMode(){if(config.appMode!=="live")return true;const site=await readSiteData();return site.settings.appMode!=="live"}
