import { Command } from 'cmdk'

export default function DuplicateGroups() {
  return (
    <Command filter={(value, search) => !search ? 1 : value === 'strong' ? 0.8 : 0.2}>
      <Command.Input />
      <Command.List>
        <Command.Group heading="Results" data-testid="low-score-group">
          <Command.Item value="weak">Weak match</Command.Item>
        </Command.Group>
        <Command.Group heading="Results" data-testid="high-score-group">
          <Command.Item value="strong">Strong match</Command.Item>
        </Command.Group>
      </Command.List>
    </Command>
  )
}
