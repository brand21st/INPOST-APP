import { Banner, BlockStack, EmptyState, Pagination, Spinner } from "@shopify/polaris";
import { useNavigate } from "react-router";

export function AdminListFeedback({
  loading,
  error,
  success,
}: {
  loading?: boolean;
  error?: string | null;
  success?: string | null;
}) {
  return (
    <BlockStack gap="300">
      {loading ? <Spinner accessibilityLabel="Loading" size="small" /> : null}
      {error ? <Banner tone="critical">{error}</Banner> : null}
      {success ? <Banner tone="success">{success}</Banner> : null}
    </BlockStack>
  );
}

export function AdminEmptyState({
  heading,
  description,
}: {
  heading: string;
  description: string;
}) {
  return (
    <EmptyState
      heading={heading}
      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
    >
      <p>{description}</p>
    </EmptyState>
  );
}

export function AdminPagination({
  previousUrl,
  nextUrl,
}: {
  previousUrl?: string;
  nextUrl?: string;
}) {
  const navigate = useNavigate();
  if (!previousUrl && !nextUrl) return null;
  return (
    <Pagination
      hasPrevious={Boolean(previousUrl)}
      hasNext={Boolean(nextUrl)}
      onPrevious={() => {
        if (previousUrl) void navigate(previousUrl);
      }}
      onNext={() => {
        if (nextUrl) void navigate(nextUrl);
      }}
    />
  );
}
