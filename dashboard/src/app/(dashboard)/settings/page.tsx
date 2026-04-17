'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { TelegramTab } from '@/components/settings/telegram-tab';
import { SystemTab } from '@/components/settings/system-tab';
import { UsersTab } from '@/components/settings/users-tab';
import { AllowedRootsTab } from '@/components/settings/allowed-roots-tab';
import { AppearanceTab } from '@/components/settings/appearance-tab';
import { OrganizationTab } from '@/components/settings/organization-tab';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage integrations, system configuration, users, and appearance.
        </p>
      </div>

      <Tabs defaultValue="organization">
        <TabsList>
          <TabsTrigger value="organization">Organization</TabsTrigger>
          <TabsTrigger value="telegram">Telegram</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="allowed-roots">Allowed Roots</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>

        <TabsContent value="organization">
          <div className="mt-4 max-w-2xl">
            <OrganizationTab />
          </div>
        </TabsContent>

        <TabsContent value="telegram">
          <div className="mt-4">
            <TelegramTab />
          </div>
        </TabsContent>

        <TabsContent value="system">
          <div className="mt-4 max-w-2xl">
            <SystemTab />
          </div>
        </TabsContent>

        <TabsContent value="users">
          <div className="mt-4 max-w-2xl">
            <UsersTab />
          </div>
        </TabsContent>

        <TabsContent value="allowed-roots">
          <div className="mt-4 max-w-3xl">
            <AllowedRootsTab />
          </div>
        </TabsContent>

        <TabsContent value="appearance">
          <div className="mt-4 max-w-2xl">
            <AppearanceTab />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
