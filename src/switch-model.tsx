import { Action, ActionPanel, confirmAlert, Icon, List, showToast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef } from "react";
import { confirmDiscard, inlineErrors, ReadError, RefreshAction, runControl, showHexError } from "./feedback";
import { readModels, readStatus, type Model } from "./hex";

export async function chooseModel(model: Model) {
  if (!model.installed) {
    const install = await confirmAlert({
      title: `Download ${model.name}?`,
      message: `Hex will download ${model.size} and switch to this model.`,
      primaryAction: { title: "Install Model" },
    });
    if (!install) return;
  }
  await runControl(["model", model.installed ? "use" : "install"], ["--", model.id]);
}

export async function cancelPreparation() {
  try {
    const preparing = (await readStatus()).model.preparing;
    if (!preparing) {
      await showToast({ title: "No model is being prepared." });
      return;
    }
    const confirmed = await confirmDiscard(
      "Cancel the current model operation?",
      `Hex is preparing ${preparing}. This stops the active download or load.`,
      "Cancel Preparation",
    );
    if (!confirmed) return;
    if ((await readStatus()).model.preparing !== preparing) {
      await showToast({ title: "Model preparation changed. Choose the current operation again." });
      return;
    }
    await runControl(["model", "cancel"]);
  } catch (error) {
    await showHexError(error);
  }
}

export default function SwitchModel() {
  const abortable = useRef<AbortController | null>(null);
  const { data, error, isLoading, revalidate } = usePromise(readModels, [], {
    ...inlineErrors,
    abortable,
    onData({ current }) {
      if (!current.preparing) return;
      const timer = setTimeout(revalidate, 2000);
      abortable.current?.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    },
  });
  if (error) return <ReadError error={error} retry={revalidate} />;
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Find a transcription model…">
      <List.Section
        title={data?.current.error ? "Model Preparation Failed" : "Models"}
        subtitle={data?.current.error || (data?.current.preparing ? `Preparing ${data.current.preparing}` : undefined)}
      >
        {data?.models.map((model) => {
          const active = data.current.id === model.id;
          return (
            <List.Item
              key={model.id}
              title={model.name}
              subtitle={model.languages.join(", ").replace("*", "Multilingual")}
              icon={active ? Icon.CheckCircle : Icon.Circle}
              accessories={[
                { text: model.size },
                { tag: active ? "Current" : model.installed ? "Installed" : "Download" },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title={model.installed ? "Use Model" : "Install and Use Model"}
                    onAction={async () => {
                      await chooseModel(model);
                      revalidate();
                    }}
                  />
                  {data.current.preparing && (
                    <Action
                      title="Cancel Model Preparation"
                      onAction={async () => {
                        await cancelPreparation();
                        revalidate();
                      }}
                    />
                  )}
                  <RefreshAction refresh={revalidate} />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
