import { Text } from '@capra/core';

interface DashboardHeaderProps {
  title: string;
  /** One or more sentences describing what the dashboard does and how to use it. */
  description: string;
}

/**
 * The heading + usage blurb shown at the top of every dashboard. Rendered by App
 * above the active workflow so it stays visible regardless of the workflow's own
 * internal view state (table / preview / results).
 */
export function DashboardHeader({ title, description }: DashboardHeaderProps) {
  return (
    <div className="dashboard-header">
      <Text as="h1" variant="heading-md">
        {title}
      </Text>
      <div className="dashboard-header-desc">
        <Text variant="body-sm-normal" color="subtle">
          {description}
        </Text>
      </div>
    </div>
  );
}
