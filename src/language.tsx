import { Action, ActionPanel, Icon, List, showToast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { inlineErrors, ReadError, RefreshAction, runControl, showHexError } from "./feedback";
import { readModels, readStatus } from "./hex";

// Hex lists "*" for wildcard models. Offer its Settings languages and accept another typed code.
const commonCodes =
  "auto en zh yue ja ko es fr de pt it ar hi bn vi ru uk nl pl tr sv da no fi cs el ro hu id ms th fa he bg hr et lv lt mt sk sl mk fil".split(
    " ",
  );
const names = new Intl.DisplayNames(["en"], { type: "language" });
function label(code: string) {
  if (code === "auto") return "Auto Detect";
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

export default function Language() {
  const [query, setQuery] = useState("");
  const { data, error, isLoading, revalidate } = usePromise(readModels, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const selected = data?.models.find((model) => model.id === data.current.id);
  const wildcard = selected?.languages.includes("*");
  const typed = query.trim().toLowerCase();
  const codes = new Set(wildcard ? commonCodes : selected?.languages);
  if (data) codes.add(data.current.language);
  if (wildcard && /^[a-z]{2,3}$/.test(typed)) codes.add(typed);
  // The catalog omits the detection capability. Hex validates an explicit auto request.
  if (selected && typed === "auto") codes.add("auto");
  return (
    <List
      isLoading={isLoading}
      filtering
      onSearchTextChange={setQuery}
      navigationTitle={data ? `Language · ${data.current.name}` : "Language"}
      searchBarPlaceholder="Find a language by name or code…"
    >
      {[...codes].map((code) => (
        <List.Item
          key={code}
          title={label(code)}
          keywords={[code]}
          subtitle={code}
          accessories={code === data?.current.language ? [{ icon: Icon.CheckCircle, text: "Current" }] : []}
          actions={
            <ActionPanel>
              <Action
                title="Use Language"
                onAction={async () => {
                  if (!selected) return;
                  try {
                    if ((await readStatus()).model.id !== selected.id) {
                      await showToast({
                        title: "The active model changed. Choose its language again.",
                      });
                      return;
                    }
                    await runControl(["model", "use"], [`--language=${code}`, "--", selected.id]);
                  } catch (error) {
                    await showHexError(error);
                  } finally {
                    revalidate();
                  }
                }}
              />
              <RefreshAction refresh={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
