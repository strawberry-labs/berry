import React, { useMemo, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from "react-native";
import type { ApprovalRequest, Message, Task } from "@berry/shared";
import { directEndpointLimitations } from "./src/direct-chat";
import { fixtureApprovals, fixtureMessages, fixtureTasks } from "./src/fixtures";
import { validateMobileConnection } from "./src/connections";

type Tab = "tasks" | "approvals" | "connect";

export default function App() {
  const [tab, setTab] = useState<Tab>("approvals");
  const [connectionUrl, setConnectionUrl] = useState("https://api.berry.test");
  const [endpointUrl, setEndpointUrl] = useState("http://192.168.1.20:11434/v1");
  const accountConnection = useMemo(() => validateMobileConnection({ kind: "berry-account", apiBaseUrl: connectionUrl }), [connectionUrl]);
  const directConnection = useMemo(() => validateMobileConnection({ kind: "lan-local", baseUrl: endpointUrl, model: "llama3.2" }), [endpointUrl]);

  return (
    <SafeAreaView className="flex-1 bg-[#0f1115]">
      <View className="border-b border-[#2a2f3a] px-5 pb-3 pt-4">
        <Text className="text-xs uppercase tracking-[2px] text-[#95b8a0]">Berry Mobile</Text>
        <Text className="mt-1 text-2xl font-semibold text-[#f7f5ef]">Approvals first, chat nearby</Text>
      </View>
      <View className="flex-row border-b border-[#2a2f3a] px-3 py-2">
        <TabButton active={tab === "approvals"} label={`Approvals ${fixtureApprovals.length}`} onPress={() => setTab("approvals")} />
        <TabButton active={tab === "tasks"} label="Tasks" onPress={() => setTab("tasks")} />
        <TabButton active={tab === "connect"} label="Connect" onPress={() => setTab("connect")} />
      </View>
      <ScrollView className="flex-1 px-4 py-4">
        {tab === "approvals" ? <ApprovalsPanel approvals={fixtureApprovals} /> : null}
        {tab === "tasks" ? <TaskPanel tasks={fixtureTasks} messages={fixtureMessages} /> : null}
        {tab === "connect" ? (
          <ConnectPanel
            accountUrl={connectionUrl}
            endpointUrl={endpointUrl}
            onAccountUrlChange={setConnectionUrl}
            onEndpointUrlChange={setEndpointUrl}
            accountWarnings={accountConnection.warnings}
            directWarnings={directConnection.warnings}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function TabButton(props: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: props.active }} className={`mr-2 rounded-md px-3 py-2 ${props.active ? "bg-[#f7f5ef]" : "bg-[#1b1f27]"}`} onPress={props.onPress}>
      <Text className={props.active ? "text-[#111318]" : "text-[#c8c3b8]"}>{props.label}</Text>
    </Pressable>
  );
}

function ApprovalsPanel({ approvals }: { approvals: ApprovalRequest[] }) {
  return (
    <View>
      {approvals.map((approval) => {
        const request = approval.request && typeof approval.request === "object" ? approval.request as { title?: unknown; detail?: unknown } : {};
        return (
          <View className="mb-3 rounded-lg border border-[#3a4238] bg-[#161b17] p-4" key={approval.id}>
            <Text className="text-xs uppercase text-[#95b8a0]">{approval.kind} approval</Text>
            <Text className="mt-1 text-lg font-semibold text-[#f7f5ef]">{typeof request.title === "string" ? request.title : "Approval required"}</Text>
            <Text className="mt-2 text-sm leading-5 text-[#c8c3b8]">{typeof request.detail === "string" ? request.detail : "Open the task for details."}</Text>
            <View className="mt-4 flex-row">
              <Pressable accessibilityRole="button" className="mr-2 rounded-md bg-[#9bd78f] px-4 py-2"><Text className="font-semibold text-[#10140f]">Approve</Text></Pressable>
              <Pressable accessibilityRole="button" className="rounded-md border border-[#55414a] px-4 py-2"><Text className="font-semibold text-[#f4b7c3]">Deny</Text></Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function TaskPanel({ tasks, messages }: { tasks: Task[]; messages: Message[] }) {
  return (
    <View>
      {tasks.map((task) => (
        <View className="mb-3 rounded-lg border border-[#303642] bg-[#151820] p-4" key={task.id}>
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-semibold text-[#f7f5ef]">{task.title}</Text>
            <Text className="rounded bg-[#242b35] px-2 py-1 text-xs uppercase text-[#aeb8c8]">{task.conversationKind === "code" ? "Code" : "Chat"}</Text>
          </View>
          <Text className="mt-1 text-sm text-[#aeb8c8]">{task.status}</Text>
        </View>
      ))}
      <View className="rounded-lg border border-[#303642] bg-[#12151b] p-4">
        <Text className="mb-2 text-xs uppercase text-[#8aa1c4]">Thread preview</Text>
        {messages.map((message) => (
          <Text className="mb-2 text-sm leading-5 text-[#d8d2c4]" key={message.id}>{message.role}: {message.parts.map((part) => typeof part.content === "string" ? part.content : JSON.stringify(part.content)).join(" ")}</Text>
        ))}
      </View>
    </View>
  );
}

function ConnectPanel(props: {
  accountUrl: string;
  endpointUrl: string;
  accountWarnings: string[];
  directWarnings: string[];
  onAccountUrlChange: (value: string) => void;
  onEndpointUrlChange: (value: string) => void;
}) {
  return (
    <View>
      <Text className="mb-2 text-sm font-semibold text-[#f7f5ef]">Berry account or self-hosted API</Text>
      <TextInput accessibilityLabel="Berry API URL" className="mb-2 rounded-md border border-[#303642] bg-[#151820] px-3 py-3 text-[#f7f5ef]" onChangeText={props.onAccountUrlChange} value={props.accountUrl} />
      {props.accountWarnings.map((warning) => <Text className="mb-2 text-sm text-[#f4d38f]" key={warning}>{warning}</Text>)}
      <Text className="mb-2 mt-4 text-sm font-semibold text-[#f7f5ef]">LAN or custom OpenAI-compatible endpoint</Text>
      <TextInput accessibilityLabel="Direct endpoint URL" className="mb-2 rounded-md border border-[#303642] bg-[#151820] px-3 py-3 text-[#f7f5ef]" onChangeText={props.onEndpointUrlChange} value={props.endpointUrl} />
      {props.directWarnings.concat(directEndpointLimitations()).map((warning) => <Text className="mb-2 text-sm text-[#f4d38f]" key={warning}>{warning}</Text>)}
    </View>
  );
}
