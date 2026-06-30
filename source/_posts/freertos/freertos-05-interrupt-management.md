---
title: "FreeRTOS 学习笔记（五）：中断管理"
date: 2025-09-02T21:44:32+08:00
categories: ["FreeRTOS"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

ISR 和任务的边界是 FreeRTOS 里最容易踩坑的地方。调错 API——`xQueueSend` 代替 `xQueueSendFromISR`——编译器不报错，运行时随机崩。临界区太长——任务响应延迟暴涨。中断优先级设错——高优先级 ISR 被 FreeRTOS 意外关掉。

这笔记记了我在 STM32F4 上做中断管理时踩过的坑和排查方法。

---

Cortex-M 的中断优先级和 FreeRTOS 的关系。

Cortex-M 用 NVIC，优先级数字**越小越高**，0 是最高。但 STM32 的 HAL 库（CMSIS）用 `PreemptPriority` + `SubPriority`，`NVIC_PriorityGroupConfig()` 决定高 4 位里几位是抢占、几位是子优先级。

FreeRTOS 只关心：哪些 ISR 能调 FromISR API，哪些不能。

```c
// FreeRTOSConfig.h
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY  0xF    // 最低优先级（Cortex-M 级别）
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5 // 能调 FromISR API 的最低优先级
#define configKERNEL_INTERRUPT_PRIORITY (configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))
#define configMAX_SYSCALL_INTERRUPT_PRIORITY (configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))
```

在 STM32F4 上 `configPRIO_BITS=4`，`configLIBRARY_LOWEST_INTERRUPT_PRIORITY=0xF`（15），`configKERNEL_INTERRUPT_PRIORITY` 计算后就是 FreeRTOS 关中断时用的掩码——所有优先级低于这个值的 ISR 会在临界区里被屏蔽。

`configMAX_SYSCALL_INTERRUPT_PRIORITY`：**只有优先级高于或等于这个值（数字 ≤5，Cortex-M 级别）的 ISR 才能调 FromISR API**。优先级 0~5 可以，6~15 不行。

如果设错——比如把上面的 `5` 写成 `1`——那么优先级 2~15 的 ISR 里调 `xQueueSendFromISR` 会导致未定义行为。编译器不报错，但内核数据结构可能被破坏。

实际配置建议：中断优先级分三档。

```
档位 0-4    : 硬实时 ISR（电机控制、高速 ADC）。不调任何 FreeRTOS API。
档位 5       : 任务唤醒 ISR（UART、SPI、定时器）。可以调 FromISR API。
档位 6-15    : FreeRTOS 临界区会屏蔽的 ISR。调 FromISR API 不安全。
```

UART、SPI、DMA 完成中断这些需要通知任务的，优先级全部拉高到 `configMAX_SYSCALL_INTERRUPT_PRIORITY`（数字 ≤5），否则 `xQueueSendFromISR` 会让系统随机崩溃。

---

`FromISR` API 和 `pxHigherPriorityTaskWoken`。

在 ISR 里不能调 `xQueueSend`、`xSemaphoreGive`——这些可能阻塞，而 ISR 不能阻塞。必须用带 `FromISR` 后缀的版本：

```c
// ❌ ISR 里绝对不能这样写
xQueueSend(queue, &data, portMAX_DELAY);

// ✅ ISR 里必须用 FromISR 版本
BaseType_t xHigherPriorityTaskWoken = pdFALSE;
xQueueSendFromISR(queue, &data, &xHigherPriorityTaskWoken);
```

`pxHigherPriorityTaskWoken` 是个传出参数——如果发送后唤醒了一个**比你被中断的任务优先级更高**的任务，它会被设为 `pdTRUE`。你在 ISR 末尾必须手动触发上下文切换：

```c
void UART_Rx_IRQHandler(void) {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    uint8_t byte = UART->DR;

    xQueueSendFromISR(g_uart_queue, &byte, &xHigherPriorityTaskWoken);

    // 这个调用告诉调度器：ISR 结束后可能需要切换任务
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}
```

忘了 `portYIELD_FROM_ISR` 的结果：消息确实发出去了，但高优先级任务要等到下一个 tick 才能被调度。延迟一个 tick（1ms~10ms），对实时场景可能就是超时。

常见 FromISR API 速查：

```c
xQueueSendFromISR(queue, &data, &woken);
xQueueSendToBackFromISR(queue, &data, &woken);
xQueueSendToFrontFromISR(queue, &data, &woken);
xQueueReceiveFromISR(queue, &data, &woken);
xSemaphoreGiveFromISR(sem, &woken);
xTaskNotifyFromISR(task, value, eAction, &woken);
xTaskNotifyGiveFromISR(task, &woken);
xTimerStartFromISR(timer, &woken);
xTimerStopFromISR(timer, &woken);
xTimerResetFromISR(timer, &woken);
xTimerChangePeriodFromISR(timer, period, &woken);
```

---

临界区：两个版本，一个坑。

```c
// 版本 1：只关任务调度，不关中断
vTaskSuspendAll();
// ... 临界操作 ...
xTaskResumeAll();

// 版本 2：关中断，什么都不能打断
taskENTER_CRITICAL();
// ... 临界操作 ...
taskEXIT_CRITICAL();
```

`taskENTER_CRITICAL` 调用 `portDISABLE_INTERRUPTS()`，关掉所有优先级低于 `configMAX_SYSCALL_INTERRUPT_PRIORITY` 的中断。硬实时 ISR（优先级 0~4）不受影响。

`vTaskSuspendAll` 只暂停任务调度，中断还是正常响应的。但如果 ISR 里调了 `xQueueSendFromISR` 导致高优先级任务就绪，调度器不会立即切换——等到 `xTaskResumeAll` 才一次性切。

坑：`taskENTER_CRITICAL` 区域太长。关中断超过 100μs 就该审视了。曾经调一个 SPI Flash 读函数放在临界区里——整片擦除 45ms——系统直接丢 UART 帧、定时器偏移。

一个判断标准：
```
需要同步任务和 ISR → taskENTER_CRITICAL（关中断）
只需要同步任务和任务 → vTaskSuspendAll（不关中断）
临界区超过 10 行 C → 考虑用 mutex/信号量替代
```

---

ISR 到任务的几种数据传递方案。

**方案 1：队列。**

```c
// ISR 收字节，任务处理完整帧
void UART_Rx_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    uint8_t byte = UART->DR;
    xQueueSendFromISR(g_uart_queue, &byte, &woken);
    portYIELD_FROM_ISR(woken);
}
```

适用：ISR 产生离散数据，任务需要逐个处理。缓冲在队列里，不怕 ISR 频率高于任务处理速度。

**方案 2：二值信号量。ISR 数据放全局缓冲区，信号量通知任务。**

```c
volatile uint8_t g_adc_buffer[1024];
SemaphoreHandle_t g_adc_done;

void ADC_DMA_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(g_adc_done, &woken);
    portYIELD_FROM_ISR(woken);
}

void vADCTask(void *pv) {
    while (1) {
        xSemaphoreTake(g_adc_done, portMAX_DELAY);
        ProcessADCBuffer(g_adc_buffer);  // 数据已经在 buffer 里了
    }
}
```

适用：DMA 传输完毕，数据量大，不想通过队列拷贝。注意：缓冲区必须是 `volatile` 或在 ISR 完成后任务才访问。

**方案 3：任务通知——最快。**

```c
// ISR 里一行就够了
void EXTI0_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    EXTI->PR = 0x01;
    vTaskNotifyGiveFromISR(g_button_task, &woken);
    portYIELD_FROM_ISR(woken);
}

// 任务里也是标准模式
void vButtonTask(void *pv) {
    while (1) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        ProcessButtonPress();
    }
}
```

比信号量快 3~5 倍——不需要创建内核对象，直接操作 TCB 里的通知值。限制：只能有一个任务等通知（不能广播），通知值是覆盖式的。按键、定时器回调、单播事件最适合。

---

中断嵌套。

Cortex-M 支持中断嵌套：高优先级 ISR 可以抢占低优先级 ISR。FreeRTOS 不禁止嵌套，但你需要注意：

1. 所有嵌套的 ISR 里都只能用 `FromISR` API。
2. 嵌套最深的那一层也要调 `portYIELD_FROM_ISR`。FreeRTOS 会在最外层 ISR 退出时检查是否有挂起的上下文切换。
3. 不要在嵌套 ISR 里使用临界区。临界区只关掉低优先级中断，嵌套的高优先级 ISR 还是能进来——可能破坏你正在保护的共享数据。

如果实在需要在 ISR 里保护共享数据，用 `taskENTER_CRITICAL_FROM_ISR()` / `taskEXIT_CRITICAL_FROM_ISR()`——会根据当前中断优先级只关掉更低优先级的：

```c
UBaseType_t uxSavedInterruptStatus;
uxSavedInterruptStatus = taskENTER_CRITICAL_FROM_ISR();
// 共享数据操作
taskEXIT_CRITICAL_FROM_ISR(uxSavedInterruptStatus);
```

---

完整例子：UART 接收 + DMA 完成的完整中断处理。

```c
#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"
#include "semphr.h"

QueueHandle_t g_uart_rx_queue;
SemaphoreHandle_t g_dma_done;

// UART 逐字节接收 ISR
void USART1_IRQHandler(void) {
    BaseType_t woken = pdFALSE;

    if (USART1->SR & USART_SR_RXNE) {
        uint8_t byte = USART1->DR;
        xQueueSendFromISR(g_uart_rx_queue, &byte, &woken);
    }

    // 溢出错误——清标志防止死 ISR
    if (USART1->SR & (USART_SR_ORE | USART_SR_FE)) {
        (void)USART1->DR;
    }

    portYIELD_FROM_ISR(woken);
}

// DMA 完成 ISR
void DMA1_Stream5_IRQHandler(void) {
    BaseType_t woken = pdFALSE;

    if (DMA1->HISR & DMA_HISR_TCIF5) {
        DMA1->HIFCR = DMA_HIFCR_CTCIF5;  // 清标志
        DMA1_Stream5->CR &= ~DMA_SXCR_EN; // 停 DMA
        xSemaphoreGiveFromISR(g_dma_done, &woken);
    }

    portYIELD_FROM_ISR(woken);
}

// UART 协议解析任务
void vUARTProtocolTask(void *pv) {
    uint8_t byte;
    uint8_t frame[256];
    uint16_t idx = 0;

    while (1) {
        if (xQueueReceive(g_uart_rx_queue, &byte, pdMS_TO_TICKS(10)) == pdTRUE) {
            if (idx < sizeof(frame)) {
                frame[idx++] = byte;
            }
        } else if (idx > 0) {
            // 10ms 没收到字节——帧结束
            ProcessFrame(frame, idx);
            idx = 0;
        }
    }
}

// DMA 数据处理任务
void vDMAProcessTask(void *pv) {
    while (1) {
        if (xSemaphoreTake(g_dma_done, pdMS_TO_TICKS(100)) == pdTRUE) {
            ProcessDMAData();
        }
    }
}

int main(void) {
    HAL_Init();
    SystemClock_Config();

    g_uart_rx_queue = xQueueCreate(256, sizeof(uint8_t));
    g_dma_done = xSemaphoreCreateBinary();

    // 中断优先级设置：必须 ≤ configMAX_SYSCALL_INTERRUPT_PRIORITY
    HAL_NVIC_SetPriority(USART1_IRQn, 5, 0);
    HAL_NVIC_SetPriority(DMA1_Stream5_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(USART1_IRQn);
    HAL_NVIC_EnableIRQ(DMA1_Stream5_IRQn);

    xTaskCreate(vUARTProtocolTask, "UART", 512, NULL, 3, NULL);
    xTaskCreate(vDMAProcessTask, "DMA", 256, NULL, 2, NULL);

    vTaskStartScheduler();
    while (1);
}
```

几个关键点：中断优先级必须设为 5（`configMAX_SYSCALL_INTERRUPT_PRIORITY`），否则 FromISR API 不安全。UART 中断里清 ORE/FE 标志防止溢出死循环。DMA 中断里先清标志再关流。

---

一个踩过的坑：ISR 频率太高导致任务饿死。

项目里接了个 1kHz 的外部触发源，每次触发进 ISR 发队列。任务优先级设得不够高，结果调度器永远来不及切给任务——ISR 返回后下一个 ISR 又来了。任务被饿死了。

解决：
1. 触发频率降到 100Hz 以下
2. 或者在 ISR 里用 `xQueueOverwriteFromISR` 代替 `xQueueSendFromISR`——只保留最新数据
3. 或者任务优先级拉高到高于其他任务

另一个坑：在 ISR 里调 `printf`。想着"就打印一行调试信息"，结果 115200 bps 串口下 50 字节日志耗时 4ms。ISR 跑 4ms→其他 ISR 被延迟→定时器偏移→PWM 抖动。调试打印放任务里，ISR 里用 GPIO 翻转 + 逻辑分析仪看波形。

---

中断优先级直观理解。

```
优先级 0 ──────────── 最高，FreeRTOS 根本管不着，临界区也关不掉
优先级 1-4 ────────── 硬实时，不会被 FreeRTOS 屏蔽，但不能调 FromISR
优先级 5 ──────────── configMAX_SYSCALL_INTERRUPT_PRIORITY，FromISR 安全
优先级 6-15 ───────── FreeRTOS 临界区会关掉这些，调 FromISR 会导致内核数据损坏
```

所以 STM32CubeMX 里默认把所有外设中断设成 0、0 是错的。应该有意识地把需要通知任务的 ISR（UART、SPI、DMA、定时器）放到优先级 5，把硬实时的 ISR（电机 FOC、保护电路）放到 0~4。
