import type { WidgetDef } from "../core/widget-types";
import { calculatorWidget } from "./calculator";
import { calendarWidget } from "./calendar";
import { mediaWidget } from "./media";
import { notesWidget } from "./notes";
import { remindersWidget } from "./reminders";
import { settingsWidget } from "./settings";
import { shelfWidget } from "./shelf";
import { sysmonWidget } from "./sysmon";
import { timerWidget } from "./timer";

/** Order here defines the tab order inside the island. */
export const widgetDefs: WidgetDef[] = [
  mediaWidget,
  shelfWidget,
  timerWidget,
  sysmonWidget,
  notesWidget,
  remindersWidget,
  calendarWidget,
  calculatorWidget,
  settingsWidget,
];
