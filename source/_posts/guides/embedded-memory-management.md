---
title: "嵌入式内存管理：从 Flash 到 Cache，代码的每一字节去哪了"
date: 2026-01-15T22:00:00+08:00
categories: ["知识向"]
tags: ["内存管理", "嵌入式", "C/C++"]
cover: /images/memory-manage/cover.png
top_img: false
---

嵌入式开发只有两件事：你要 CPU 干什么，你要内存怎么用。后者更容易翻车——栈溢出、内存碎片、DMA 跑飞、Cache 一致性问题，每一样都能让你抱着逻辑分析仪看到天亮。

这篇文章从芯片内存布局开始，覆盖裸机 MCU 和 Linux 嵌入式两端的全貌。

---

## 一、你的芯片长什么样

STM32F407 的内存地图，从 `0x0000_0000` 读到 `0xFFFF_FFFF`：

```
0x0000_0000 ┌──────────┐
            │  Flash   │ 典型的 1MB，你的代码和常量在这里
0x0800_0000 ├──────────┤
            │  SRAM1   │ 112KB，main stack + heap + 全局变量
0x2000_0000 ├──────────┤
            │  SRAM2   │ 16KB，额外的
0x2001_C000 ├──────────┤
            │  CCM RAM │ 64KB，紧耦合内存，CPU 独占，DMA 碰不到
0x1000_0000 ├──────────┤
            │  AHB/APB │ 总线上的外设寄存器
0x4000_0000 ├──────────┤
            │  FSMC/   │ 外部 SRAM/SDRAM，如果你焊了
0x6000_0000 ├──────────┤
            │  保留    │
0xFFFF_FFFF └──────────┘
```

几件重要的事：

Flash 不是 RAM——写 Flash 要整个扇区擦除，速度比 RAM 慢 100 倍以上，不能当普通内存用。

CCM（紧耦合内存）是 CPU 私有的——DMA 无法访问 CCM 里的数据。如果你把 ADC 的 DMA 目标地址设成 CCM，数据永远到不了。这是新手最常见的"CubeMX 配好 DMA 不工作"的答案。

SRAM 不是统一速度—— 有些 MCU 的总线矩阵决定了：CPU 访问 SRAM1 可以同时和 DMA 访问 SRAM2 并行，但如果两个主控同时抢一块 SRAM，总有一个人要等。

---

## 二、链接脚本和内存布局

你写的 `.c` 文件最终被链接成一段连续的二进制映像，存放在 Flash 上。上电后，启动代码把某些段从 Flash 搬到 RAM。

一个典型的 STM32 链接脚本：

```ld
MEMORY
{
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 1024K
    SRAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
}

SECTIONS
{
    .isr_vector : { KEEP(*(.isr_vector)) } > FLASH

    .text : { *(.text*) } > FLASH        /* 代码 */

    .rodata : { *(.rodata*) } > FLASH    /* 只读数据：const 全局变量、字符串字面量 */

    .data : { *(.data*) } > SRAM AT> FLASH /* 已初始化全局变量：Flash 留一份，运行时拷到 RAM */

    .bss : { *(.bss*) } > SRAM           /* 未初始化全局变量：只占 RAM，启动代码清零 */

    .heap : { . = ALIGN(8); __heap_start = .; . += 0x8000; } > SRAM  /* 堆 */

    .stack : { . = ALIGN(8); __stack_top = .; } > SRAM               /* 栈 */
}
```

加载到 Flash 上的映像长这样：

```
┌──────────────┐
│  .isr_vector │
├──────────────┤
│  .text       │  代码
├──────────────┤
│  .rodata     │  只读数据（const 变量、printf 的格式串）
├──────────────┤
│  .data (LMA) │  .data 段的"初始值"，启动后 memcpy 到 RAM
└──────────────┘
```

上电后 RAM 里长这样：

```
0x20000000 ┌──────────────┐
           │  .data       │  已初始化全局（Flash 拷过来的）
           ├──────────────┤
           │  .bss        │  未初始化全局（全 0）
           ├──────────────┤
           │  heap ──→    │  malloc 从这里分配，向上涨
           │   ←── stack  │  函数调用从这里用，向下涨
           │              │
           │  两者之间是   │  ← 危险区域，撞了就出事
           │  自由空间      │
0x20020000 └──────────────┘
```

栈和堆共享同一块空间，方向相反—— 堆从低地址往上长，栈从高地址往下长。如果中间的空间耗尽，它们会相遇——这时候写堆的数据覆盖了栈帧，或反之。这就是"栈溢出"最经典的表现形式：程序行为随机崩溃，通常在某个完全不相关的函数里。

---

## 三、全局变量存哪里

同一个 `int`，前面加不同的关键字，编译器把它放在不同地方：

```c
int global_var = 42;           // .data 段   Flash 一份 ROM，启动拷到 RAM
int global_zero = 0;           // .bss 段    只占 RAM，不占 Flash
static int file_var;           // .bss      作用域限于本文件
const int rom_var = 100;       // .rodata   Flash 里，CPU 直接读 Flash
static const int table[] = {}; // .rodata   同上

void func(void) {
    int local = 0;             // 栈         随函数调用增减
    static int persistent = 0; // .bss      只初始化一次，跨函数调用保持值
}
```

嵌入式里最容易被忽视的是 `const`——不加 `const`，一个本可以放 Flash 的表就占了 RAM。`const` 表放 Flash 不仅省 RAM，而且读 Flash 的速度并不慢（ART Accelerator 能做到接近 0 wait state）。

```c
// ❌ 512 字节的表，占了 RAM
uint8_t sin_table[512] = {0, 3, 6, 9, ...};

// ✅ 同样的表，在 Flash 里，不占 RAM
const uint8_t sin_table[512] = {0, 3, 6, 9, ...};
```

---

## 四、栈

栈是每个任务（包括 main 开始前的启动代码）的生命线。每次函数调用，当前 CPU 寄存器和返回地址被 push 到栈上。局部变量、函数参数也在这里。

**栈有多大？** 默认值通常藏在 CubeMX 的 `Project Manager → Linker Settings` 里或者链接脚本里，一般是几 KB。对于裸机 main + ISR，可能够用。一旦上了 RTOS，每个任务有自己独立的栈，总栈消耗 = main 栈 + 每个任务的栈 + ISR 用到的栈。

**栈溢出了怎么发现的？**

最常见的方式：`FreeRTOSConfig.h` 里配置 `configCHECK_FOR_STACK_OVERFLOW=2`。RTOS 在任务创建时用 `0xA5` 填满栈空间，每次任务切换时检查栈顶的 canary 值被没被改写。

裸机下没有 RTOS 帮你检查，但可以自己加。链接脚本里栈顶在 `__stack_top`，开启一个硬件定时器定期检查 `SP` 寄存器（`__get_MSP()` / `__get_PSP()`）有没有超出栈底。

**局部大数组是个危险信号：**

```c
void ProcessData(void) {
    uint8_t buffer[4096];  // ⚠️ 4KB 栈一次性消费，如果只剩 2KB，这行就跑飞
    // ...
}
```

嵌入式里大 buffer 尽量用 `static`——编译期在 .bss 里分配好，或者用内存池。

---

## 五、对齐

Cortex-M 支持非对齐访问（大部分情况下），但代价是性能。一个 `uint32_t` 跨了两个 word 边界，CPU 要读两次存储器再拼起来。DMA 和某些外设干脆不支持非对齐传输。

编译器的自然对齐规则：

```c
struct BadlyAligned {
    uint8_t  a;     // 1 byte
    uint32_t b;     // 4 bytes，必须在 4 字节边界
    uint16_t c;     // 2 bytes
};
// sizeof = 12 bytes（不是 1+4+2=7）
// 布局：[a][_][_][_][b][b][b][b][c][c][_][_]
```

重排一下成员顺序能省 4 字节：

```c
struct WellAligned {
    uint32_t b;     // 4 bytes
    uint16_t c;     // 2 bytes
    uint8_t  a;     // 1 byte
};
// sizeof = 8 bytes
// 布局：[b][b][b][b][c][c][a][_]
```

`__attribute__((packed))` 能省掉 padding，但会让 CPU 做非对齐访问：

```c
struct __attribute__((packed)) Tight {
    uint8_t  a;
    uint32_t b;     // 现在直接从 offset 1 开始
    uint16_t c;
};
// sizeof = 7 bytes，但每次读写 b 都是两次内存访问
```

适用场景：网络协议头、Flash 存储结构——宁可牺牲一点速度也要省空间。不适用：频繁读写的变量。

---

## 六、内存映射 I/O

外设寄存器不是普通内存。它们被映射到地址空间里，对它们的访问不能像对 RAM 一样随意优化。

volatile 不只是"告诉编译器别优化"—— 它还阻止编译器重排 volatile 访问顺序、阻止将多次读写合并成一次。

```c
// ❌ 没有 volatile——编译器可能缓存 *reg 的值，死循环
uint32_t *reg = (uint32_t *)0x40020014;
while (!(*reg & 0x01));  // 等了很久，始终读不到标志位

// ✅ volatile——每次都从地址读
volatile uint32_t *reg = (volatile uint32_t *)0x40020014;
while (!(*reg & 0x01));  // 正确
```

但 `volatile` 有三个做不到的事：

1. 不保证原子性——32 位写操作在 Cortex-M3/4 是原子的，但对位带操作不保证。
2. 不提供内存屏障——多核系统或 Cache 存在时，需要 `DSB`/`DMB`/`ISB` 指令。
3. 不保证外设和内存之间的顺序——如果既要写寄存器又要更新内存，需要加 `__DSB()` 确保顺序。

---

## 七、DMA 和 Cache 一致性

DMA 直接在存储器之间搬数据，CPU 感知不到。问题出在 Cache 上——如果 CPU 的 Cache 里有一份"旧"数据，DMA 已经更新了 SRAM 里的实际内容，CPU 读到的 Cache 还是旧的。

```c
// 这个函数不会自动帮你刷 Cache
HAL_ADC_Start_DMA(&hadc1, (uint32_t *)adc_buffer, 1024);
```

STM32F7/H7 系列有 Data Cache（D-Cache），解决办法：

```c
// 方案 1：把 DMA 目标区域设为 non-cacheable（MPU 配置）

// 方案 2：手动维护 Cache
SCB_CleanInvalidateDCache_by_Addr((uint32_t *)adc_buffer, 1024 * sizeof(uint32_t));

// 方案 3：DMA 的 buffer 放在 CCM 或者其他 non-cacheable 区域
__attribute__((section(".ccmram"))) uint32_t adc_buffer[1024];
```

方案 3 最简单——CCM 不走 Cache。但 CCM 只能 CPU 访问，DMA 不能读写 CCM。所以"把 DMA buffer 放 CCM"本身是矛盾的——**DMA buffer 不能放 CCM，但 CPU 处理用的 buffer 可以。**

---

## 八、自定义内存区域

有时候你需要把特定变量放在特定地址。比如启动代码里的向量表偏移：

```c
// 把这个数组放在 .isr_vector 段
__attribute__((section(".isr_vector"))) const uint32_t vector_table[256];

// 把这个变量放在 CCM RAM
__attribute__((section(".ccmram"))) uint8_t fast_buffer[4096];

// 把这个函数放在 RAM 里执行（比 Flash 快，但占 RAM）
__attribute__((section(".ramfunc"))) void CriticalISR(void);
```

链接脚本里需要预定义这些段。

---

## 九、内存调试和常见 bug

HardFault 是 Cortex-M 最经典的异常，通常跟内存有关。读 HardFault 的栈帧，几个寄存器能告诉你原因：

- `UFSR`(UsageFault)：非对齐访问、协处理器不存在、除以 0
- `BFSR`(BusFault)：访问非法地址、非对齐在 bus 层面被拒
- `MMFSR`(MemManage)：MPU 权限冲突、执行不可执行区域

调试时在 HardFault_Handler 里打断点，查看压栈的 `PC`——它会指向导致异常的指令。

栈破坏，最常见的一个模式：某个函数的局部 buffer 溢出，覆盖了自己的返回地址。返回到一个随机位置→HardFault。排查方法：检查栈顶 canary（如果 RTOS 开启了栈溢出检测），或者在栈底打一个断点数据观察点。

Double Free—— 动态分配时最经典的 bug——同一个指针 free 两次，导致空闲链表损坏。在没有 MMU 的 MCU 上没有 segmentation fault，损坏可能在很久之后才显现。

Use-After-Free—— 释放后继续用，新分配刚好拿到同一块内存。数据混乱，极难排查。

对于没有 heap 的裸机系统来说，这两种 bug 不存在——因为根本没有 `malloc/free`。这也是为什么很多安全关键系统选择静态分配。

---

## 十、Linux 嵌入式的内存

树莓派、Jetson、i.MX 这些跑 Linux 的系统也是嵌入式。它们有 MMU，有虚拟内存——这改变了内存管理的全部规则，但新的坑也来了。

### 虚拟内存

每个进程看到的是自己的地址空间，不是物理内存。`malloc` 返回的指针指向的是虚拟地址，内核在后台维护虚拟→物理的映射。

```bash
# 看一个进程的内存映射
cat /proc/$(pidof my_daemon)/maps
```

输出类似：

```
00400000-00401000 r-xp  .text        # 代码段，只读
00402000-00403000 r--p  .rodata      # 只读数据
00403000-00404000 rw-p  .data/.bss   # 全局变量
7f8a00000000 rw-p  heap             # 堆
7fff12340000 rw-p  stack            # 栈
```

### kmalloc vs vmalloc vs CMA

内核模块分配内存有三种选择：

```c
// kmalloc — 物理连续，适合 DMA。上限通常 4MB
void *buf = kmalloc(4096, GFP_KERNEL);

// vmalloc — 虚拟连续，物理可以不连续。不能用于 DMA
void *buf = vmalloc(1024 * 1024);

// CMA — Contiguous Memory Allocator，为 DMA 预留大块连续物理内存
// 在 dts 里配置：linux,cma = <0x10000000>; // 256MB
```

嵌入式 Linux 设备树里 CMA 配多大直接决定了你的视频编码器、GPU、摄像头能不能正常工作。配太小——DMA 分配失败，视频帧丢失；配太大——留给应用层的内存不够，OOM。

### OOM Killer

Linux 的内存过度承诺（overcommit）：`malloc` 可以返回成功，但内核还没分配物理页。直到你真正写入这块内存，内核才分配页。如果所有进程同时写自己申请的内存，物理内存不够了，OOM Killer 根据一套打分规则挑一个进程杀掉。

嵌入式设备上 OOM 最常见的原因：
1. 内存泄漏——某个守护进程持续 `malloc` 不 `free`
2. CMA 太大，留给系统的页太少
3. GPU/VPU 驱动分配了大量 DMA buffer 没有回收

排查命令：

```bash
dmesg | grep -i oom          # 看杀的谁
cat /proc/meminfo             # 总体内存状况
cat /proc/$(pidof xxx)/status # 某个进程的 VmRSS、VmSize
```

### 共享内存和 mmap

`mmap` 直接把文件或设备映射到进程地址空间，不用 `read/write`：

```c
int fd = open("/dev/my_device", O_RDWR);
volatile uint32_t *regs = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                                MAP_SHARED, fd, 0);
regs[0] = 0x01;  // 直接写设备寄存器
```

和裸机的 MMIO 本质上一样——只是裸机用物理地址，Linux 用 mmap 后的虚拟地址。但有了页表和 TLB，每次访问多了一层翻译开销。

---

## 十一、看 .map 文件：编译器不会骗你

链接器输出一个 `.map` 文件，里面记录了每一字节内存的去向。大部分嵌入式工程师不看这个文件——直到 Flash 不够的那天。

```
Memory Configuration

Name             Origin         Length         Attributes
FLASH            0x08000000     0x00100000     xr
SRAM             0x20000000     0x00020000     xrw
*default*        0x00000000     0xffffffff

Linker script and memory map

.text           0x08000200      0x8a3c
    main.o (.text.main)                 0x08000200        0x120
    adc_driver.o (.text.ADC_Init)       0x08000320         0x9c
    ...

.data           0x20000000       0x458    load address 0x08008e00
    main.o (.data.sensor_calib)         0x20000000          0x4
    ...

.bss            0x20000458      0x110c
    main.o (.bss.rx_buffer)             0x20000458        0x800  ← 这个 buffer 占了 2KB
    logger.o (.bss.log_buffer)          0x20000c58        0x200
    ...
```

从 .map 里一眼能看出来：哪个 `.o` 文件最肥、哪个全局变量占最多 RAM。优化内存的第一步不是换算法，是打开 .map 找 `占空间最大的前5个变量`。

几个快速排查命令：

```bash
# 按大小排序看符号
arm-none-eabi-nm --size-sort -t d build/firmware.elf | tail -20

# 看每个 .o 的段大小
arm-none-eabi-size build/*.o | sort -k2 -rn | head -10
```

---

## 十二、内存池：O(1) 分配、零碎片

比 `malloc` 快、比静态分配灵活。FreeRTOS 不带内存池，但自写一个只需要 30 行：

```c
#define POOL_BLOCK_SIZE 64
#define POOL_BLOCK_COUNT 32

typedef struct {
    uint8_t buf[POOL_BLOCK_SIZE * POOL_BLOCK_COUNT];
    uint32_t free_map;  // 每个 bit 代表一个 block 是否空闲
} MemPool;

void Pool_Init(MemPool *p) { p->free_map = (1U << POOL_BLOCK_COUNT) - 1; }

void *Pool_Alloc(MemPool *p) {
    int idx = __builtin_ctz(p->free_map);       // 找第一个 1 位
    if (idx >= POOL_BLOCK_COUNT) return NULL;
    p->free_map &= ~(1U << idx);
    return &p->buf[idx * POOL_BLOCK_SIZE];
}

void Pool_Free(MemPool *p, void *ptr) {
    int idx = ((uint8_t *)ptr - p->buf) / POOL_BLOCK_SIZE;
    p->free_map |= (1U << idx);
}
```

位图分配：时间 O(1)，不产生碎片，天生线程安全（`__builtin_ctz` 编译后是一条 `RBIT + CLZ` 指令）。适合固定大小的对象池——网络包、传感器数据帧、任务参数结构体。

### RTOS 自带的内存方案

FreeRTOS 有五种堆实现（heap_1~5），选型速查：

| heap | 释放 | 合并 | 适用 |
|------|------|------|------|
| heap_1 | ❌ | ❌ | 对象永不删除 |
| heap_2 | ✅ | ❌ | 固定大小分配 |
| heap_3 | ✅ | 看libc | 原型验证 |
| heap_4 | ✅ | ✅ | **大多数项目的首选** |
| heap_5 | ✅ | ✅ | 多块RAM拼堆 |

heaps_1~5 的详细对比、静态分配配置、碎片图解、编译选项在另一篇笔记 [FreeRTOS 学习笔记（六）：内存管理](/2025/09/28/freertos/freertos-memory-management/) 里有完整说明。这里不重复。

---

## 十三、内存故障排查速查表

| 现象 | 最可能原因 | 先查 |
|------|----------|------|
| 程序随机 HardFault | 栈溢出 | 栈 canary 值是否被改写 |
| `malloc` 返回 NULL | 碎片或泄漏 | `xPortGetMinimumEverFreeHeapSize()` |
| 变量值莫名改变 | 堆/栈碰撞 或 缓冲区溢出 | 检查是否有局部大数组 |
| DMA 数据不对 | Cache 不一致 或 CCM 误用 | DMA 目标地址是不是 CCM |
| `memcpy` 后程序飞了 | 目标地址内存不够 | 看调用栈里最近的 `malloc` |
| 函数返回后变量丢值 | 返回了局部变量地址 | 检查函数签名，返回的是不是栈地址 |
| 代码跑得很慢 | 非对齐访问 | 检查 struct 是否有 packed，去掉不必要的 |

---

## 十四、通用黄金法则

十条从踩坑中总结的规律：

1. 能静态分配就别动态分配——编译器能帮你算好的，别等到运行时。
2. 必须动态分配就用内存池，不是malloc—— O(1)、零碎片、易调试。
3. malloc 只在初始化时用，主循环里出现 malloc/free 就要考虑内存池了。
4. 看 .map 文件，不看 .map 的内存优化都是盲人摸象。
5. 每个函数开局部数组之前想三秒—— 这个数组一定要在栈上吗？
6. 大 buffer 用 static，哪怕只需要这个函数内用—— static 放 .bss，不炸栈。
7. DMA 方向不能是 CCM， 这条写在你的架构设计文档里。
8. F7/H7 上 DMA buffer 要么 non-cacheable，要么每次手动刷 Cache
9. 学会用链接脚本， `__attribute__((section(...)))` 能让你把关键数据放在正确的地方。
10. 不要靠猜—— 怀疑栈溢出，加 canary。怀疑碎片，调 `xPortGetMinimumEverFreeHeapSize`。怀疑哪个变量大，看 .map。

---

## 十五、选型建议

裸机和 Linux 两条路差别很大，但内存选择的优先级相似：

**裸机 MCU：**
1. `static` 数组和固定栈——零风险
2. 启动时分配一次，永不释放
3. 运行时频繁分配→内存池（O(1)，零碎片）
4. 实在不行才上通用 malloc

**Linux 嵌入式：**
1. 默认用 `malloc/free`——有 MMU，碎片对应用层影响小很多
2. DMA 需求→`kmalloc` 或 CMA 区
3. 大块内存→`mmap` 映射文件或共享内存
4. 监控 `VmRSS` 和 `VmSize`——它们是 OOM 的前兆

两条路上最早的项目都从最简单的方案开始。裸机用静态分配，Linux 用 `malloc`——够用了再优化。

