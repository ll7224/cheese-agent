import { Command } from 'cmdk'
import * as React from 'react'

const scores = { temporary: 1, project: 0.2, action: 0.8 }

export default function DynamicGroups() {
  const [temporary, setTemporary] = React.useState(true)
  return (
    <div>
      <button onClick={() => setTemporary((value) => !value)}>
        {temporary ? 'Remove temporary item' : 'Add temporary item'}
      </button>
      <Command filter={(value, search) => {
        if (!search) return 1
        if (search === 'actions-first' && value === 'temporary') return 0.1
        return scores[value] || 0
      }}>
        <Command.Input placeholder="Search ranking" />
        <Command.List>
          <Command.Empty>No results.</Command.Empty>
          <Command.Group heading="Projects">
            {temporary && <Command.Item value="temporary">Temporary project</Command.Item>}
            <Command.Item value="project">Project</Command.Item>
          </Command.Group>
          <Command.Group heading="Actions">
            <Command.Item value="action">Action</Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  )
}
