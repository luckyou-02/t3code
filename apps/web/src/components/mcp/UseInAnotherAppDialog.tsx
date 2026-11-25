import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Dialog } from "../ui/dialog";
import { WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";

const requestAtom = Atom.make<{ readonly environmentId: EnvironmentId | null } | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mcp:use-in-another-app"),
);

/** Opens the dialog for `environmentId`, or for the one Sharing & access picks when null. */
export function openUseInAnotherApp(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(requestAtom, { environmentId });
}

const close = () => appAtomRegistry.set(requestAtom, null);

/** Hosted once at the root, so Cmd-K and Settings can open it from anywhere. */
export function UseInAnotherAppDialogHost() {
  const request = useAtomValue(requestAtom);
  return request === null ? null : <UseInAnotherAppDialog requested={request.environmentId} />;
}

function UseInAnotherAppDialog({ requested }: { readonly requested: EnvironmentId | null }) {
  const { environment, label } = useAccessEnvironment(requested);
  const gt = useGT();
  const title = `${gt("Use T3 Code in another app (MCP)")} · ${label ?? "T3 Code"}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <WizardPopup>
        <WizardHeader title={title} />
        <WizardPanel>
          <div className="space-y-3 py-4 text-sm">
            <p className="font-medium text-foreground">
              {environment === null
                ? gt("Connect to an environment first.")
                : gt("T3 Connect is not available in this build.")}
            </p>
          </div>
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}
