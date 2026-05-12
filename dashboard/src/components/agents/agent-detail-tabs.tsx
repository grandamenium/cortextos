'use client';

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ProfileForm } from './profile-form';
import { TasksTab } from './tasks-tab';
import { MemoryTab } from './memory-tab';
import { LogsTab } from './logs-tab';
import { CronsTab } from './crons-tab';
import { SettingsTab } from './settings-tab';
import { GoalsTab } from './goals-tab';
import type {
  AgentDetail,
  IdentityFields,
  SoulFields,
  Task,
} from '@/lib/types';

interface AgentDetailTabsProps {
  detail: AgentDetail;
  soulFields: SoulFields;
  tasks: Task[];
}

export function AgentDetailTabs({
  detail,
  soulFields,
  tasks,
}: AgentDetailTabsProps) {
  const identityFields: IdentityFields = {
    name: detail.identity.name,
    role: detail.identity.role,
    emoji: detail.identity.emoji,
    vibe: detail.identity.vibe,
    workStyle: detail.identity.workStyle,
  };

  const [profileActionSlot, setProfileActionSlot] = useState<HTMLDivElement | null>(null);

  return (
    <Tabs defaultValue="profile">
      <div className="flex items-center justify-between gap-3">
        <TabsList variant="line">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="crons">Crons</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="goals">Goals</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <div ref={setProfileActionSlot} className="flex items-center" />
      </div>

      <TabsContent value="profile">
        <ProfileForm
          agentName={detail.systemName ?? detail.name}
          org={detail.org}
          identity={identityFields}
          soul={soulFields}
          actionSlot={profileActionSlot}
        />
      </TabsContent>

      <TabsContent value="tasks">
        <TasksTab tasks={tasks} />
      </TabsContent>

      <TabsContent value="crons">
        <CronsTab agentName={detail.systemName ?? detail.name} />
      </TabsContent>

      <TabsContent value="memory">
        <MemoryTab
          agentName={detail.systemName ?? detail.name}
          org={detail.org}
          memoryRaw={detail.memoryRaw}
          memoryFiles={detail.memoryFiles}
        />
      </TabsContent>

      <TabsContent value="logs">
        <LogsTab
          agentName={detail.systemName ?? detail.name}
          org={detail.org}
          logFiles={detail.logFiles}
        />
      </TabsContent>

      <TabsContent value="goals">
        <GoalsTab agentName={detail.systemName ?? detail.name} org={detail.org} />
      </TabsContent>

      <TabsContent value="settings">
        <SettingsTab agentName={detail.systemName ?? detail.name} />
      </TabsContent>
    </Tabs>
  );
}
