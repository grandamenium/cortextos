'use client';

import { FilterBar } from '@/components/shared';
import type { FilterConfig } from '@/components/shared';

interface TaskFiltersProps {
  orgs: string[];
  agents: string[];
  projects: string[];
  filters: {
    org: string;
    agent: string;
    priority: string;
    project: string;
    status: string;
  };
  onChange: (key: string, value: string) => void;
  onClearAll: () => void;
}

export function TaskFilters({
  orgs,
  agents,
  projects,
  filters,
  onChange,
  onClearAll,
}: TaskFiltersProps) {
  const filterConfigs: FilterConfig[] = [
    {
      key: 'org',
      label: 'Org',
      value: filters.org,
      onChange: (v) => onChange('org', v),
      options: [
        { value: 'all', label: 'All Orgs' },
        ...orgs.map((o) => ({ value: o, label: o })),
      ],
    },
    {
      key: 'agent',
      label: 'Agent',
      value: filters.agent,
      onChange: (v) => onChange('agent', v),
      options: [
        { value: 'all', label: 'All Agents' },
        ...agents.map((a) => ({ value: a, label: a })),
      ],
    },
    {
      key: 'priority',
      label: 'Priority',
      value: filters.priority,
      onChange: (v) => onChange('priority', v),
      options: [
        { value: 'all', label: 'All Priorities' },
        { value: 'urgent', label: 'Urgent' },
        { value: 'high', label: 'High' },
        { value: 'normal', label: 'Normal' },
        { value: 'low', label: 'Low' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      value: filters.status,
      onChange: (v) => onChange('status', v),
      options: [
        { value: 'all', label: 'All Statuses' },
        { value: 'pending', label: 'Pending' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'waiting', label: 'Waiting' },
        { value: 'blocked', label: 'Blocked' },
        { value: 'completed', label: 'Completed' },
      ],
    },
  ];

  if (projects.length > 0) {
    filterConfigs.push({
      key: 'project',
      label: 'Project',
      value: filters.project,
      onChange: (v) => onChange('project', v),
      options: [
        { value: 'all', label: 'All Projects' },
        ...projects.map((p) => ({ value: p, label: p })),
      ],
    });
  }

  return <FilterBar filters={filterConfigs} onClearAll={onClearAll} />;
}
