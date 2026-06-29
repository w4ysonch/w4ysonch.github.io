---
title: "FreeRTOS 学习笔记（六）：内存管理"
date: 2025-09-28T23:42:36+08:00
categories: ["FreeRTOS"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

FreeRTOS 不替你管理堆——它提供了五种 `heap_x.c` 实现，你选一种编译进项目。选错了，轻则 RAM 碎片导致 `pvPortMalloc` 返回 NULL，重则任务创建失败系统起不来。

核心问题不是"哪种最好"，而是"你的项目能接受什么代价"。

---

先从 FreeRTOS 什么时候需要内存开始。

每次调 `xTaskCreate`、`xQueueCreate`、`xSemaphoreCreateBinary`、`xTimerCreate`——这些创建 API 内部都调 `pvPortMalloc`，从你提供的堆里分一块。

一个典型项目的内存去向：

```
┌──────────────────────────────────────┐
│ FreeRTOS 堆（ucHeap[N] 或链接脚本段）  │
│                                      │
│  Task Stack (LED, 128W)             │
│  Task Stack (Logger, 256W)          │
│  Task Stack (Button, 128W)          │
│  Queue Buffer (sensor_queue, 40B)   │
│  Semaphore TCB (binary, ~80B)       │
│  Timer TCB (2个, ~80B each)         │
│  ...                                │
└──────────────────────────────────────┘
```

所有不用 `Static` 后缀 API 创建的对象，TCB 和缓冲区都在这个堆里。

---

heap_1：最简单，永不释放。

```c
// FreeRTOSConfig.h
#define configAPPLICATION_ALLOCATED_HEAP 0
// 链接 heap_1.c
// 堆大小（编译期确定）
#define configTOTAL_HEAP_SIZE ((size_t)(15 * 1024))
```

`pvPortMalloc` 成功，`vPortFree` 是空函数——**没有任何释放逻辑**。malloc 指针一直往前推进，直到堆耗尽。永远不会产生碎片。

适用：**只在启动阶段创建对象的项目**。你的任务、队列、信号量全部在 `main` 里建好，运行中不再创建。这是很多安全关键系统（医疗、航空）的选择——确定性最高，没有"运行时分配失败"的风险。

不适用：运行中频繁创建/删除对象的项目。

---

heap_2：能释放，但不合并。

`pvPortMalloc` 用 best-fit 算法找最小的合适空闲块。`vPortFree` 把块放回空闲链表，但**不合并相邻空闲块**。

```
分配 100B → 分配 200B → 释放 100B → 分配 150B

空闲链表：[100B hole] [free space]   ← 两个相邻空闲块不合并
新请求 150B：找不到够大的块 → 失败（其实两块加起来 100+free space > 150B）
```

适用：**分配和释放大小相同**的场景。比如你的项目里所有队列大小都一样（`sizeof(sensor_data_t)`），释放后留下的空洞刚好能装下一个同样的请求。

不适用：大小随机的分配/释放。但很多老项目用了十几年 heap_2 也没出问题——因为分配/释放并不频繁。

---

heap_3：直接包标准库 `malloc/free`。

```c
void *pvPortMalloc(size_t xWantedSize) {
    return malloc(xWantedSize);
}
void vPortFree(void *pv) {
    free(pv);
}
```

把 FreeRTOS 的堆交给编译器的标准库。标准库的 `malloc` 通常实现了合并相邻空闲块，比 heap_2 聪明。

但有两个问题：标准库 `malloc` 通常**不是线程安全的**——需要 `configUSE_MALLOC_FAILED_HOOK` 配合或者自己包一个 mutex。线程安全性取决于你的工具链和 libc 实现。

适用：快速原型验证。或者你的编译器和 libc 明确提供了线程安全的 malloc。

---

heap_4：能释放 + 合并相邻空闲块。

和 heap_2 结构相同，唯一区别：`vPortFree` **合并相邻空闲块**。

```
分配 100B → 分配 200B → 释放 100B
空闲链表：[合并后的大块]  ← 相邻空闲自动合并
新请求 150B：找到合并后的块 → 成功
```

适用：运行时有分配和释放，大小不确定。**大部分嵌入式项目的默认选择。**

注意：heap_4 仍然没有碎片整理——内存碎片是时间的函数，不是释放次数的函数。运行一个月后，即使有空闲空间，可能找不到连续的大块。

---

heap_5：heap_4 + 多块不连续 RAM。

`heap_5` 和 `heap_4` 逻辑一样，但允许堆分布在多块物理上不连续的 RAM 里。使用前先调用 `vPortDefineHeapRegions` 注册内存区域：

```c
HeapRegion_t xHeapRegions[] = {
    { (uint8_t *)0x20000000UL, 0x10000 },  // CCM RAM 64KB
    { (uint8_t *)0x20010000UL, 0x20000 },  // SRAM1 128KB
    { NULL, 0 }                              // 结束标志
};
vPortDefineHeapRegions(xHeapRegions);
```

适用：MCU 有多块 RAM（比如 STM32F4 的 CCM + SRAM），你想把它们拼起来用。或者外部 SDRAM 想当 FreeRTOS 堆。

---

五种方案速查。

| 方案 | 释放 | 合并 | 确定性 | 适用 |
|------|------|------|------|------|
| heap_1 | ❌ | ❌ | 最高 | 只在启动时创建对象 |
| heap_2 | ✅ | ❌ | 中 | 分配/释放大小一致 |
| heap_3 | ✅ | 看 libc | 低 | 快速原型 |
| heap_4 | ✅ | ✅ | 中高 | **首选，适合大部分项目** |
| heap_5 | ✅ | ✅ | 中高 | 多块 RAM 拼堆 |

---

静态分配：彻底摆脱堆。

不想用堆？所有创建 API 都有 `Static` 版本：

```c
// 动态分配
TaskHandle_t h = NULL;
xTaskCreate(vTask, "Task", 256, NULL, 1, &h);

// 静态分配——你自己提供栈和 TCB
static StackType_t  task_stack[256];
static StaticTask_t task_tcb;
TaskHandle_t h = xTaskCreateStatic(vTask, "Task", 256, NULL, 1,
                                    task_stack, &task_tcb);
```

队列、信号量、互斥锁、定时器、事件组——全部有对应的 `Static` 版本：

```c
xQueueCreateStatic(length, item_size, buffer, &queue_buffer);
xSemaphoreCreateBinaryStatic(&sem_buffer);
xSemaphoreCreateMutexStatic(&mutex_buffer);
xTimerCreateStatic(name, period, autoReload, id, callback, &timer_buffer);
```

开了 `configSUPPORT_STATIC_ALLOCATION` 之后，FreeRTOS 优先用你自己提供的缓冲区，不用 `pvPortMalloc`。连 idle 任务和 timer 任务的栈都能静态分配：

```c
// 空走任务和定时器任务的栈你也能自己提供
static StackType_t idle_task_stack[configMINIMAL_STACK_SIZE];
static StaticTask_t idle_task_tcb;
vApplicationGetIdleTaskMemory(&idle_task_tcb, (void **)&idle_task_stack,
                                configMINIMAL_STACK_SIZE);
```

静态分配的好处：编译期确定内存用量，没有碎片，连接器能检测溢出。代价：所有缓冲区必须手动规划大小，改一个任务栈可能影响全部。

---

内存碎片到底长什么样。

运行一个月后，即使 `xPortGetFreeHeapSize()` 返回 8KB，`pvPortMalloc(1024)` 也可能返回 NULL。因为那 8KB 是分散的碎片，没有连续 1KB。

```
[已用 256B][空闲 80B][已用 300B][空闲 200B][已用 128B][空闲 120B]...[空闲 8KB 总量]
                                                   ↑
                                    最大连续空闲块可能只有 120B
```

heap_4 能合并相邻的空闲块——但前提是它们相邻。如果两个空闲块之间隔着一个还在用的块，合并不了。

缓解策略：
1. 分配大小尽量统一，减少碎片形态多样性。
2. 生命周期相近的对象一起创建/销毁。
3. 高频创建/销毁用内存池，不走 `pvPortMalloc`。FreeRTOS 没有自带内存池，但可以自己写 ring buffer 或者从 heap_4 里单独分一块出来做池子。
4. 监控 `xPortGetFreeHeapSize()` 和 `xPortGetMinimumEverFreeHeapSize()`——后者比前者更有意义。

---

调试：`malloc` 失败怎么排查。

打开 `configUSE_MALLOC_FAILED_HOOK`，在 `FreeRTOSConfig.h` 里：

```c
#define configUSE_MALLOC_FAILED_HOOK 1

// 然后在 main.c 或某处实现这个函数
void vApplicationMallocFailedHook(void) {
    // 停在这里，调试器看调用栈
    __asm("bkpt #0");
}
```

任何一次 `pvPortMalloc` 返回 NULL，这里就会被调。用调试器看调用栈，知道是哪个 API 失败的。常见的：`configTOTAL_HEAP_SIZE` 设太小、任务栈太多太大、队列长度太大。

查看当前堆使用情况：

```c
printf("Free heap: %lu bytes\n", xPortGetFreeHeapSize());
printf("Min ever free: %lu bytes\n", xPortGetMinimumEverFreeHeapSize());
```

---

实际选型建议。

大部分项目从 heap_4 开始。`configTOTAL_HEAP_SIZE` 先设大些（比如 MCU RAM 的 60%），用 `xPortGetMinimumEverFreeHeapSize` 跑几周确认实际用量，再收紧。

安全关键项目用 heap_1 + 静态分配。RAM 规划工具（如 `.map` 文件 + Excel）提前算好每块内存，连接脚本里预留好 FreeRTOS 堆的段。

有外部 SDRAM 的项目用 heap_5，把内部 SRAM 和外部 SDRAM 拼起来。但注意 SDRAM 比 SRAM 慢很多——任务的栈放 SRAM，大缓冲区放 SDRAM。

需要高频动态管理对象（比如网络包）的项目——不要靠 FreeRTOS 堆。自己实现内存池，切固定大小块，O(1) 分配/释放，零碎片。
