<script setup lang="ts">
import { FlexRender, tableFeatures, useTable } from '@tanstack/vue-table'

type RowData = Record<string, any>
const props = defineProps<{
  rows: RowData[]
  columns: Array<{ key: string; label: string }>
  filterPlaceholder?: string
  emptyTitle?: string
  emptyDescription?: string
  emptyIcon?: string
}>()
const emit = defineEmits<{ select: [row: RowData] }>()
const filter = ref('')
const columns = props.columns.map((column) => ({ accessorKey: column.key, header: column.label }))
const data = ref<RowData[]>([])
watchEffect(() => {
  data.value = props.rows.filter((row) =>
    Object.values(row).some((value) =>
      String(value).toLowerCase().includes(filter.value.toLowerCase()),
    ),
  )
})
const features = tableFeatures({})
const table = useTable({ features, columns, data })
</script>

<template>
  <div>
    <div class="border-b border-white/8 p-3">
      <div class="relative max-w-xs">
        <UIcon name="i-lucide-search" class="absolute left-3 top-2.5 size-4 text-[#5f7b72]" /><input
          v-model="filter"
          class="native-input py-2 pl-9 text-sm"
          :placeholder="filterPlaceholder ?? 'Filter inventory…'"
          :aria-label="filterPlaceholder ?? 'Filter inventory'"
        />
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr v-for="headerGroup in table.getHeaderGroups()" :key="headerGroup.id">
            <th v-for="header in headerGroup.headers" :key="header.id">
              <FlexRender v-if="!header.isPlaceholder" :header="header" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in table.getRowModel().rows"
            :key="row.id"
            class="cursor-pointer"
            tabindex="0"
            @click="emit('select', row.original)"
            @keydown.enter="emit('select', row.original)"
          >
            <td v-for="cell in row.getAllCells()" :key="cell.id">
              <slot :name="`cell-${cell.column.id}`" :row="row.original" :value="cell.getValue()"
                ><FlexRender :cell="cell"
              /></slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <EmptyState
      v-if="!table.getRowModel().rows.length"
      :title="filter ? 'No matching results' : (emptyTitle ?? 'No resources yet')"
      :description="
        filter
          ? 'Adjust your search to see more resources.'
          : (emptyDescription ?? 'Gridora did not return any resources for this organization.')
      "
      :icon="filter ? 'i-lucide-search-x' : (emptyIcon ?? 'i-lucide-inbox')"
    />
  </div>
</template>
