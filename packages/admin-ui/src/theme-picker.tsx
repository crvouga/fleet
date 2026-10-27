/** @jsxImportSource react */
import { Button, Menu, Text, useMantineColorScheme } from '@mantine/core';
import {
  IconCheck,
  IconDeviceDesktop,
  IconMoon,
  IconSun,
} from '@tabler/icons-react';

const options = [
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
  { value: 'auto', label: 'System', icon: IconDeviceDesktop },
] as const;

export function ThemePicker() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const current =
    options.find((option) => option.value === colorScheme) ?? options[2];
  const Icon = current.icon;
  return (
    <Menu position="bottom-end" withinPortal transitionProps={{ duration: 0 }}>
      <Menu.Target>
        <Button
          variant="default"
          size="xs"
          aria-label={`Color theme: ${current.label}`}
          leftSection={<Icon size={16} />}
          className="theme-trigger"
        >
          <Text span size="xs" visibleFrom="xs">
            {current.label}
          </Text>
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Appearance</Menu.Label>
        {options.map(({ value, label, icon: OptionIcon }) => (
          <Menu.RadioItem
            key={value}
            value={value}
            checked={colorScheme === value}
            checkIcon={<IconCheck size={14} />}
            rightSection={<OptionIcon size={16} />}
            closeMenuOnClick
            onChange={() => setColorScheme(value)}
          >
            {label}
          </Menu.RadioItem>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
