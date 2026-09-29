import { useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { ConnectIcon, SaveIcon, SearchIcon } from "@shopify/polaris-icons";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import type { DropOffice } from "../../domain/india-post/client.server";
import {
  connectIndiaPost,
  loadIndiaPostSettings,
  saveBarcodeConfiguration,
  saveDropOffice,
  saveIndiaPostContracts,
  searchOfficesForShop,
  inspectBarcodeRange,
  type IndiaPostSettings,
} from "../../domain/india-post/settings.server";

type ActionData =
  | { intent: "connect"; ok: true }
  | { intent: "connect"; ok: false; error: string }
  | { intent: "save_contracts"; ok: true }
  | { intent: "save_contracts"; ok: false; error: string }
  | { intent: "validate_barcode"; ok: true; available: number }
  | { intent: "validate_barcode"; ok: false; error: string }
  | { intent: "save_barcode"; ok: true; available: number; remaining: number }
  | { intent: "save_barcode"; ok: false; error: string }
  | { intent: "search_offices"; ok: true; offices: DropOffice[] }
  | { intent: "search_offices"; ok: false; error: string }
  | { intent: "save_office"; ok: true }
  | { intent: "save_office"; ok: false; error: string };

function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function serial(form: FormData, name: string) {
  const text = field(form, name).trim();
  if (!/^\d+$/.test(text)) return Number.NaN;
  return Number(text);
}

function environmentOf(value: string): "UAT" | "PRODUCTION" {
  return value === "PRODUCTION" ? "PRODUCTION" : "UAT";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  try {
    const settings = await loadIndiaPostSettings(shop.id);
    return { settings, loadError: null as string | null };
  } catch {
    return { settings: null, loadError: "India Post configuration could not be loaded." };
  }
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { shop } = await requireInstalledShop(request);
  const form = await request.formData();
  const intent = field(form, "intent");
  if (intent === "connect") {
    const result = await connectIndiaPost(shop.id, {
      environment: environmentOf(field(form, "environment")),
      username: field(form, "username"),
      password: field(form, "password"),
      bulkCustomerId: field(form, "bulkCustomerId"),
    });
    return result.ok ? { intent, ok: true } : { intent, ok: false, error: result.error };
  }
  if (intent === "save_contracts") {
    const result = await saveIndiaPostContracts(shop.id, {
      speedPostContractId: field(form, "speedPostContractId"),
      businessParcelsContractId: field(form, "businessParcelsContractId"),
    });
    return result.ok ? { intent, ok: true } : { intent, ok: false, error: result.error };
  }
  if (intent === "validate_barcode" || intent === "save_barcode") {
    const current = await loadIndiaPostSettings(shop.id);
    const input = {
      prefix: field(form, "prefix"),
      startNumber: serial(form, "startNumber"),
      endNumber: serial(form, "endNumber"),
      environment: current.environment,
    };
    if (intent === "validate_barcode") {
      const result = inspectBarcodeRange(input);
      return result.ok
        ? { intent, ok: true, available: result.available }
        : { intent, ok: false, error: result.error };
    }
    const result = await saveBarcodeConfiguration(shop.id, input);
    return result.ok
      ? { intent, ok: true, available: result.available, remaining: result.remaining }
      : { intent, ok: false, error: result.error };
  }
  if (intent === "search_offices") {
    const result = await searchOfficesForShop(shop.id, field(form, "pincode"));
    return result.ok ? { intent, ok: true, offices: result.offices } : { intent, ok: false, error: result.error };
  }
  if (intent === "save_office") {
    const result = await saveDropOffice(shop.id, {
      officeId: field(form, "officeId"),
      pincode: field(form, "pincode"),
      officeName: field(form, "officeName"),
    });
    return result.ok ? { intent, ok: true } : { intent, ok: false, error: result.error };
  }
  return { intent: "connect", ok: false, error: "That action is not available" };
};

function connectionTone(settings: IndiaPostSettings, connecting: boolean) {
  if (connecting) return { label: "Connecting", tone: "info" as const };
  if (settings.status === "CONNECTED") return { label: "Connected", tone: "success" as const };
  if (settings.status === "FAILED") return { label: "Connection failed", tone: "critical" as const };
  return { label: "Not connected", tone: undefined };
}

export default function IndiaPostSettingsPage() {
  const { settings, loadError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const pending = navigation.state !== "idle" && typeof pendingIntent === "string" ? pendingIntent : null;
  const [environment, setEnvironment] = useState(settings?.environment ?? "UAT");
  const [bulkCustomerId, setBulkCustomerId] = useState(settings?.bulkCustomerId ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionAttempted, setConnectionAttempted] = useState(false);
  const [speedPostContractId, setSpeedPostContractId] = useState(settings?.speedPostContractId ?? "");
  const [businessParcelsContractId, setBusinessParcelsContractId] = useState(settings?.businessParcelsContractId ?? "");
  const [prefix, setPrefix] = useState(settings?.barcode?.prefix ?? "");
  const [startNumber, setStartNumber] = useState(settings?.barcode ? String(settings.barcode.startNumber) : "");
  const [endNumber, setEndNumber] = useState(settings?.barcode ? String(settings.barcode.endNumber) : "");
  const [officeId, setOfficeId] = useState(settings?.dropOffice?.id ?? "");
  const [pincode, setPincode] = useState(settings?.dropOffice?.pincode ?? "");
  const barcodeIntent = useRef<HTMLInputElement>(null);
  const officeIntent = useRef<HTMLInputElement>(null);
  if (!settings) {
    return (
      <Page title="India Post">
        <Banner tone="critical" title={loadError ?? "India Post configuration could not be loaded."} />
      </Page>
    );
  }
  const connection = connectionTone(settings, pending === "connect");
  const offices = actionData?.intent === "search_offices" && actionData.ok ? actionData.offices : [];
  const validatedAvailable =
    actionData &&
    (actionData.intent === "validate_barcode" || actionData.intent === "save_barcode") &&
    actionData.ok
      ? actionData.available
      : null;

  return (
    <Page title="India Post" subtitle="Configure credentials, contracts, barcode inventory, and your drop office.">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Connection</Text>
                  <Badge tone={connection.tone}>{connection.label}</Badge>
                </InlineStack>
                {actionData?.intent === "connect" && actionData.ok ? <Banner tone="success" title="Connected" /> : null}
                {actionData?.intent === "connect" && !actionData.ok ? <Banner tone="critical" title={actionData.error} /> : null}
                {settings.status === "FAILED" && settings.lastError && actionData?.intent !== "connect" ? (
                  <Banner tone="critical" title={settings.lastError} />
                ) : null}
                <Form
                  method="post"
                  onSubmit={(event) => {
                    setConnectionAttempted(true);
                    if (!username.trim() || !password.trim()) event.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="connect" />
                  <FormLayout>
                    <Select
                      label="Environment"
                      name="environment"
                      options={[{ label: "UAT", value: "UAT" }, { label: "Production", value: "PRODUCTION" }]}
                      value={environment}
                      onChange={(value) => setEnvironment(value === "PRODUCTION" ? "PRODUCTION" : "UAT")}
                    />
                    <TextField label="Bulk customer ID" name="bulkCustomerId" autoComplete="off" helpText="10 digits, from India Post" value={bulkCustomerId} onChange={setBulkCustomerId} />
                    <TextField label="India Post username" name="username" autoComplete="username" requiredIndicator error={connectionAttempted && !username.trim() ? "Username is required." : undefined} value={username} onChange={setUsername} />
                    <TextField label="India Post password" name="password" type="password" autoComplete="current-password" requiredIndicator error={connectionAttempted && !password.trim() ? "Password is required." : undefined} value={password} onChange={setPassword} />
                    {settings.hasPassword ? <Text as="p" tone="subdued">A password is already saved for this shop.</Text> : null}
                    <Button submit variant="primary" icon={ConnectIcon} loading={pending === "connect"}>Connect to India Post</Button>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Contract IDs</Text>
                {actionData?.intent === "save_contracts" && actionData.ok ? <Banner tone="success" title="Contract IDs saved" /> : null}
                {actionData?.intent === "save_contracts" && !actionData.ok ? <Banner tone="critical" title={actionData.error} /> : null}
                <Form method="post">
                  <input type="hidden" name="intent" value="save_contracts" />
                  <FormLayout>
                    <TextField label="Speed Post Contract ID" name="speedPostContractId" autoComplete="off" helpText="8 digits" value={speedPostContractId} onChange={setSpeedPostContractId} />
                    <TextField label="Business Parcels Contract ID" name="businessParcelsContractId" autoComplete="off" helpText="8 digits" value={businessParcelsContractId} onChange={setBusinessParcelsContractId} />
                    <Button submit variant="primary" icon={SaveIcon} loading={pending === "save_contracts"}>Save contracts</Button>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Barcode series</Text>
                {actionData?.intent === "save_barcode" && actionData.ok ? <Banner tone="success" title="Barcode configuration saved" /> : null}
                {actionData && (actionData.intent === "validate_barcode" || actionData.intent === "save_barcode") && !actionData.ok ? (
                  <Banner tone="critical" title={actionData.error} />
                ) : null}
                <Form method="post">
                  <input ref={barcodeIntent} type="hidden" name="intent" value="validate_barcode" />
                  <FormLayout>
                    <TextField label="Prefix" name="prefix" autoComplete="off" value={prefix} onChange={setPrefix} />
                    <FormLayout.Group>
                      <TextField label="Starting number" name="startNumber" type="text" inputMode="numeric" autoComplete="off" value={startNumber} onChange={setStartNumber} />
                      <TextField label="Ending number" name="endNumber" type="text" inputMode="numeric" autoComplete="off" value={endNumber} onChange={setEndNumber} />
                    </FormLayout.Group>
                    {validatedAvailable != null ? <Text as="p">Available barcodes: {validatedAvailable}</Text> : null}
                    {actionData?.intent === "save_barcode" && actionData.ok ? (
                      <Text as="p">Remaining barcodes: {actionData.remaining}</Text>
                    ) : settings.barcode ? <Text as="p">Remaining barcodes: {settings.barcode.remaining}</Text> : null}
                    <ButtonGroup>
                      <Button submit loading={pending === "validate_barcode"} onClick={() => { if (barcodeIntent.current) barcodeIntent.current.value = "validate_barcode"; }}>Validate range</Button>
                      <Button submit variant="primary" icon={SaveIcon} loading={pending === "save_barcode"} onClick={() => { if (barcodeIntent.current) barcodeIntent.current.value = "save_barcode"; }}>Save barcode configuration</Button>
                    </ButtonGroup>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Drop office</Text>
                <Text as="p">The post office where you hand over parcels. Search by pincode or enter the 8-digit office ID.</Text>
                {settings.status !== "CONNECTED" ? <Banner tone="info" title="Connect to India Post before searching for a drop office." /> : null}
                {actionData?.intent === "search_offices" && !actionData.ok ? <Banner tone="critical" title={actionData.error} /> : null}
                {actionData?.intent === "save_office" && actionData.ok ? <Banner tone="success" title="Drop office saved" /> : null}
                {actionData?.intent === "save_office" && !actionData.ok ? <Banner tone="critical" title={actionData.error} /> : null}
                <Form method="post">
                  <input ref={officeIntent} type="hidden" name="intent" value="search_offices" />
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField label="Office ID" name="officeId" autoComplete="off" helpText="8 digits" value={officeId} onChange={setOfficeId} />
                      <TextField label="Find by pincode" name="pincode" autoComplete="postal-code" helpText="Search by the 6-digit pincode." value={pincode} onChange={setPincode} />
                    </FormLayout.Group>
                    <ButtonGroup>
                      <Button submit icon={SearchIcon} loading={pending === "search_offices"} onClick={() => { if (officeIntent.current) officeIntent.current.value = "search_offices"; }}>Find offices</Button>
                      <Button submit variant="primary" icon={SaveIcon} loading={pending === "save_office"} onClick={() => { if (officeIntent.current) officeIntent.current.value = "save_office"; }}>Save office ID</Button>
                    </ButtonGroup>
                  </FormLayout>
                </Form>
                {actionData?.intent === "search_offices" && actionData.ok && offices.length === 0 ? <Banner tone="info" title="No delivery offices were found for that pincode." /> : null}
                {offices.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text"]}
                    headings={["Office name", "Office ID", "Pincode", "Type", "City", "State", "Rolled out", "Action"]}
                    rows={offices.map((office) => [
                      office.officeName,
                      office.officeId,
                      office.pincode,
                      office.officeTypeCode,
                      office.cityName,
                      office.stateName,
                      office.isRolledOut ? "Yes" : "No",
                      <Form method="post" key={office.officeId}>
                        <input type="hidden" name="intent" value="save_office" />
                        <input type="hidden" name="officeId" value={office.officeId} />
                        <input type="hidden" name="officeName" value={office.officeName} />
                        <input type="hidden" name="pincode" value={office.pincode} />
                        <Button submit size="slim" loading={pending === "save_office"}>Save</Button>
                      </Form>,
                    ])}
                  />
                ) : null}
                <Text as="p" tone="subdued">
                  {settings.dropOffice
                    ? `Selected drop office: ${settings.dropOffice.name || "Office"} ${settings.dropOffice.id}${settings.dropOffice.pincode ? ` · ${settings.dropOffice.pincode}` : ""}`
                    : "No drop office selected."}
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Configuration status</Text>
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={["Setting", "Status"]}
                rows={[
                  ["Connection", connection.label],
                  ["Speed Post contract", settings.speedPostContractId ? "Set" : "Not set"],
                  ["Business Parcels contract", settings.businessParcelsContractId ? "Set" : "Not set"],
                  ["Barcode range", settings.barcode ? "Saved" : "Not saved"],
                  ["Drop office", settings.dropOffice ? settings.dropOffice.id : "Not selected"],
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
