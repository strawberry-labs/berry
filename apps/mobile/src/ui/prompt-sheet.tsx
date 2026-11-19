import * as React from "react";
import { View } from "react-native";
import { Button } from "./button";
import { Input } from "./primitives";
import { Sheet } from "./sheet";

/** A one-field form in a sheet (rename, create project); works on both platforms. */
export function PromptSheet({ open, onOpenChange, title, description, initialValue = "", placeholder, submitLabel = "Save", onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  initialValue?: string;
  placeholder?: string | undefined;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = React.useState(initialValue);
  React.useEffect(() => { if (open) setValue(initialValue); }, [initialValue, open]);
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} {...(description ? { description } : {})}>
      <Input value={value} onChangeText={setValue} placeholder={placeholder} autoFocus returnKeyType="done" onSubmitEditing={submit} accessibilityLabel={title} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="outline" label="Cancel" onPress={() => onOpenChange(false)} />
        <Button label={submitLabel} disabled={!value.trim()} onPress={submit} />
      </View>
    </Sheet>
  );
}
