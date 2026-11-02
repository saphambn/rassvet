/**
 * Public API for extension UIs. Extensions import from "@rassvet/sdk" only,
 * never from host internals, so the host can evolve without breaking them.
 *
 * An extension UI is `extensions/<id>/ui/index.tsx` with a default export of
 * type `ExtensionUi`. Its routes are mounted under `/ext/<id>/`.
 */
import type { ComponentType } from "react";
import type { CleanupContribution } from "@/lib/cleanup";
import type { ResourceKind } from "@/lib/palette";
import type { TerraformContribution } from "@/lib/terraform";

export { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
export { ApiError, api } from "@/lib/api";
export { useSession } from "@/lib/session";
export { cn } from "@/lib/utils";
export * from "@/components/ui";
export { registerIcons } from "@/components/icons";
export { DataTable, type Column, type BulkAction } from "@/components/DataTable";
export { Dialog, ConfirmDialog } from "@/components/Dialog";
export { useToast } from "@/components/Toast";
export { CodeBlock, CopyButton, downloadText } from "@/components/CodeBlock";
export { lang, tr, trx } from "@/lib/i18n";
// Gateway helpers: use the service name `ext:<id>` for the extension's own `/api/ext/<id>/os/*` gateway.
export {
  os,
  useOsList,
  useOsGet,
  useOsPaged,
  useListOrPages,
  useInvalidate,
  type Svc,
  type ServerFilter,
  age,
  // Neutron / Nova data an extension commonly needs
  type Network,
  type Subnet,
  type Port,
  type FloatingIp,
  type Server,
  useNetworks,
  useSubnets,
  usePorts,
  useFloatingIps,
  useServers,
  portLabel,
  serverIps,
  serverLabel,
  serverStatus,
  // Nova flavors and key pairs (e.g. for forms that start instances through another service)
  type Flavor,
  type Keypair,
  useFlavors,
  useKeypairs,
} from "@/lib/os";
// Neutron extension aliases loaded on this cloud, to show features only where they work
export { useNeutronExtensions } from "@/lib/neutron";
// Glance images a project can boot (its own, accepted shared ones and public ones, active only)
export { type Image, useBootImages } from "@/lib/image";
export { fmtDate, fmtBytes } from "@/lib/format";
export { useProjects } from "@/lib/identity";
export { useNewParam, useTab } from "@/lib/useTab";
export { Link, useNavigate, useInAdmin } from "@/components/Link";
export { useParams, useSearchParams } from "react-router";
export { ActionDialog } from "@/components/ActionDialog";
export { Picker, MultiPicker, type PickOption } from "@/components/Picker";
export { ComboInput, type ComboOption } from "@/components/ComboInput";
export { ActionMenu, type MenuEntry } from "@/components/Menu";
export { KeyValueEditor, type KvRow, toRows, fromRows, kvError } from "@/components/KeyValueEditor";
export { type ResourceKind, type PaletteContext, findPath } from "@/lib/palette";
export { type TerraformContribution, type TfSource, type TfSection, type TfItem, type TfContext, type TfGen, type TfSelection, str as hclString } from "@/lib/terraform";
export { type CleanupContribution, type CleanupContext, type Finder, idle } from "@/lib/cleanup";
export { useProjectFilter, filters, text, choice, idFilter, nameRegex, matches, statusLabel } from "@/lib/filters";

export interface ExtensionRoute {
  /** Path relative to `/ext/<id>/`, e.g. "load-balancers" or "load-balancers/:id". */
  path: string;
  component: ComponentType;
  /** Only mounted in the admin view (`/admin/ext/<id>/<path>`); every route is mounted there too. */
  adminOnly?: boolean;
}

/** What an extension adds to the command palette (Ctrl/⌘ K). */
export interface PaletteContribution {
  /** Extra words that find the extension's pages, e.g. "k8s" for Kubernetes. */
  keywords?: string;
  /** "Create …" actions; `path` is relative to the extension's base (`/ext/<id>` or `/admin/ext/<id>`). */
  actions?: { id: string; label: string; icon: string; path: string; keywords?: string }[];
  /** Resources found by name or by a pasted ID. */
  resources?: ResourceKind[];
}

export interface ExtensionUi {
  routes: ExtensionRoute[];
  palette?: PaletteContribution;
  /** Resources of the extension in Operations › Export to Terraform. */
  terraform?: TerraformContribution;
  /** Leftovers of the extension in Operations › Cleanup. */
  cleanup?: CleanupContribution;
}
