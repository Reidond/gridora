<template>
  <div class="auth-grid bg-[#07110f]">
    <section class="flex flex-col p-6 sm:p-10 lg:p-12">
      <BrandMark />
      <div class="my-auto py-14"><slot /></div>
      <footer class="flex gap-5 text-xs text-[#718c84]">
        <NuxtLink to="/legal/terms" class="hover:text-white">Terms</NuxtLink
        ><NuxtLink to="/legal/privacy" class="hover:text-white">Privacy</NuxtLink
        ><a href="https://github.com/Reidond/gridora" class="hover:text-white" rel="noreferrer"
          >Source</a
        >
      </footer>
    </section>
    <aside
      class="relative hidden overflow-hidden border-l border-white/[.06] bg-[#0b1814] p-12 lg:flex lg:flex-col lg:justify-end"
    >
      <div
        class="absolute inset-0 opacity-40"
        style="
          background-image:
            linear-gradient(rgba(45, 212, 167, 0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(45, 212, 167, 0.08) 1px, transparent 1px);
          background-size: 48px 48px;
          mask-image: linear-gradient(to bottom, transparent, black);
        "
      ></div>
      <div class="relative max-w-xl">
        <p class="eyebrow">Organization-scoped control plane</p>
        <h2 class="mt-5 text-4xl font-semibold leading-tight tracking-[-.04em] text-white">
          Your game infrastructure,<br /><span class="text-emerald-300"
            >without the guesswork.</span
          >
        </h2>
        <p class="mt-5 max-w-lg text-base leading-relaxed text-[#8ea9a1]">
          Review authorized inventory, submit supported operations, and keep each organization's
          resources and credentials inside its own boundary.
        </p>
        <div class="mt-10 grid grid-cols-3 gap-3">
          <div
            v-for="item in [
              ['Scoped', 'Organizations'],
              ['Durable', 'Operations'],
              ['Explicit', 'Capabilities'],
            ]"
            :key="item[1]"
            class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"
          >
            <p class="text-lg font-semibold text-white">{{ item[0] }}</p>
            <p class="mt-1 text-[11px] text-[#718c84]">{{ item[1] }}</p>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>
