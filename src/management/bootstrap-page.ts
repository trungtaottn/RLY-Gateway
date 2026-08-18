import { managementUiHtml } from "./ui/page.js";

export const SESSION_COOKIE_NAME = "ag_mgmt_session";

export function bootstrapPageHtml(): string {
  return managementUiHtml();
}
