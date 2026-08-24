<script setup lang="ts">
const route = useRoute()
await navigateTo(`/o/${route.params.slug}/overview`, { replace: true })
</script>
<template><div /></template>
