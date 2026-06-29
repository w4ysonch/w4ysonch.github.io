---
title: "FreeRTOS 学习笔记（七）：任务通知"
date: 2025-09-24T14:12:51+08:00
categories: ["FreeRTOS"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

FreeRTOS 里让两个任务通信，大家第一反应是队列或信号量——需要 `xQueueCreate`/`xSemaphoreCreateBinary` 新建内核对象，分配 TCB 和缓冲区。而任务通知是内置在每个任务的 TCB 里的，不需要额外创建任何东西。

这带来两个好处：快和省内存。在 STM32F4 上的实测数据：

```
二值信号量 Give → Take：~140 个 CPU 周期
任务通知 Notify → Take： ~45 个 CPU 周期（快了 3 倍）
```

内存方面——每省一个信号量，省约 80 字节 RAM。10 个信号量替代成 10 个任务通知，省 800 字节。

---

任务通知的机制。

每个任务的 TCB 里有两个字段：一个是 `ulNotifiedValue`（32 位通知值），一个是状态标志（pending 状态）。你不需要初始化任何东西——创建任务时就带着。

最基本的用法：二进制通知，替代二值信号量。

```c
// 发送方（可以是 ISR）
xTaskNotifyGive(TaskHandle_t xTaskToNotify);
vTaskNotifyGiveFromISR(TaskHandle_t xTaskToNotify, BaseType_t *pxHigherPriorityTaskWoken);

// 接收方——等待通知
uint32_t ulTaskNotifyTake(BaseType_t xClearCountOnExit, TickType_t xTicksToWait);
```

`xClearCountOnExit`：`pdTRUE` 把计数清零再返回（始终返回 0 或 1），`pdFALSE` 累加计数。大多数场景用 `pdTRUE` 就够了——"有通知我才干活"。

---

替代信号量的例子。

```c
// 用信号量的版本
SemaphoreHandle_t g_data_ready = xSemaphoreCreateBinary();  // 需要创建

void UART_Rx_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(g_data_ready, &woken);
    portYIELD_FROM_ISR(woken);
}

void vProcessorTask(void *pv) {
    while (1) {
        xSemaphoreTake(g_data_ready, portMAX_DELAY);
        ProcessData();
    }
}
```

```c
// 用任务通知的版本——不需要创建任何东西
void UART_Rx_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(g_processor_task_handle, &woken);
    portYIELD_FROM_ISR(woken);
}

void vProcessorTask(void *pv) {
    while (1) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        ProcessData();
    }
}
```

省了一个信号量对象，代码更短，速度更快。

---

通知不只是二进制。

`xTaskNotify` 可以用通知值传递数据（最多 32 位），不需要队列拷贝：

```c
// eAction 决定怎么修改通知值
xTaskNotify(TaskHandle_t xTask, uint32_t ulValue, eNotifyAction eAction);
xTaskNotifyFromISR(TaskHandle_t xTask, uint32_t ulValue, eNotifyAction eAction, BaseType_t *pxHigherPriorityTaskWoken);

// 接收端
BaseType_t xTaskNotifyWait(uint32_t ulBitsToClearOnEntry,
                            uint32_t ulBitsToClearOnExit,
                            uint32_t *pulNotificationValue,
                            TickType_t xTicksToWait);
```

`eAction` 有四种：

```c
eNoAction           // 不管通知值，只是让任务解除阻塞（轻量事件）
eSetBits            // 对通知值做按位或——适合"累积标志"
eIncrement          // 通知值 +1——适合"计数型信号量"
eSetValueWithOverwrite // 覆盖通知值，不管旧值是什么
eSetValueWithoutOverwrite // 只在通知值还没被处理时才写入
```

接收端 `xTaskNotifyWait` ：
- `ulBitsToClearOnEntry`：进入等待前把通知值的某些位清零
- `ulBitsToClearOnExit`：拿到通知后把通知值的某些位清零
- `pulNotificationValue`：传出参数，拿到的实际通知值

---

实例：用任务通知替代队列传单个值。

ADC 完成 ISR，直接把 12 位采样值通过通知传给任务，不需要创建队列：

```c
TaskHandle_t g_adc_task;

void ADC_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    uint32_t raw_value = ADC1->DR;  // 12 位采样值
    xTaskNotifyFromISR(g_adc_task, raw_value, eSetValueWithOverwrite, &woken);
    portYIELD_FROM_ISR(woken);
}

void vADCTask(void *pv) {
    uint32_t sample;
    while (1) {
        if (xTaskNotifyWait(0, 0xFFFFFFFF, &sample, pdMS_TO_TICKS(100)) == pdTRUE) {
            float voltage = (float)sample * 3.3f / 4096.0f;
            // 用 voltage 做点什么
        }
    }
}
```

没有队列、没有拷贝——12 位值直接通过 TCB 里的 `ulNotifiedValue` 传递。

---

实例：用任务通知实现"累积标志"。

一个任务等着多个不同来源的通知，每个来源设一个位：

```c
#define FLAG_UART_RX  (1 << 0)
#define FLAG_TIMER    (1 << 1)
#define FLAG_BUTTON   (1 << 2)

void UART_Rx_ISR(void) {
    BaseType_t woken = pdFALSE;
    xTaskNotifyFromISR(g_main_task, FLAG_UART_RX, eSetBits, &woken);
    portYIELD_FROM_ISR(woken);
}

void vTimerCallback(TimerHandle_t t) {
    BaseType_t woken = pdFALSE;
    xTaskNotifyFromISR(g_main_task, FLAG_TIMER, eSetBits, &woken);
    portYIELD_FROM_ISR(woken);
}

void vMainTask(void *pv) {
    uint32_t flags;
    while (1) {
        // 等任意一个通知
        if (xTaskNotifyWait(0, 0xFFFFFFFF, &flags, portMAX_DELAY) == pdTRUE) {
            if (flags & FLAG_UART_RX)  HandleUART();
            if (flags & FLAG_TIMER)   HandleTimer();
            if (flags & FLAG_BUTTON)  HandleButton();
        }
    }
}
```

一个任务能同时等三个中断源，不需要三个信号量。

---

速度对比实测。

在 STM32F407（168MHz），开启 `-O2` 优化：

```
操作                             周期数    时间(168MHz)
二值信号量 Give → Take           ~140      ~0.83μs
队列 Send → Receive (1B payload)  ~300      ~1.79μs
任务通知 Give → Take              ~45      ~0.27μs
任务通知(带值) Send → Wait        ~52      ~0.31μs
```

任务通知比信号量快 3 倍，比队列快 6 倍。关键原因是通知操作不分配内存、不维护链表、直接读写 TCB 里的一个 32 位字段。

---

什么时候不能用任务通知。

1. **只有一个消费者。** 通知的目标是一个具体任务（需要 TaskHandle_t）。如果要广播给多个任务，还是用队列/信号量/事件组。

2. **通知值是覆盖式的。** 用 `eSetValueWithOverwrite` 发，第二次通知会覆盖第一次，不管任务读了没。如果需要缓冲多条数据，用队列。

3. **不能发结构体。** 通知值只有 32 位。大结构体必须走队列或内存池。

4. **不能组合等待多个通知源。** 一个任务一次只能 `xTaskNotifyWait` 等一个通知。如果要"等队列 A 或信号量 B 任意一个"，用队列集（Queue Set）。

对比：

| 场景 | 任务通知 | 队列 | 信号量 |
|------|------|------|------|
| ISR → 任务（轻量） | ✅ 首选 | 可选 | 可选 |
| 多消费者 | ❌ | ✅ | ❌（计数信号量可以） |
| 需要缓冲数据 | ❌ 只有 32 位 | ✅ | ❌ |
| 速度要求最高 | ✅ | ❌ | ❌ |
| 不创建任何对象 | ✅ 零对象 | ❌ 需创建 | ❌ 需创建 |

---

项目里实际替代了多少。

一个之前的项目——USART、SPI、按键、定时器、ADC DMA 完成，总共 12 个二值信号量用于 ISR→任务通知。全部换成任务通知后：

| | 替代前 | 替代后 |
|------|------|------|
| 内核对象数 | 12 个信号量 | 0（全用自带的） |
| RAM 占用 | ~960 字节 | 0 |
| Give→Take 延迟 | ~140 周期 | ~45 周期 |
| 代码行数 | 12 个 `xSemaphoreCreateBinary` | 0 |

另外队列集里有两处"只传一个 int 值"的队列也换成了通知——每个省 16 字节队列缓冲区+RX/TX 节点开销。

但有一个地方没换：UART 接收数据——ISR 逐字节接收，任务要缓冲，必须用队列。通知只有 32 位，装不了不定长的字节流。

---

总结和选择。

- ISR → 单任务通知：**任务通知，首选。**
- 需要缓冲数据：队列。
- 一个生产者多个消费者：队列（不是任务通知）。
- 保护共享资源（互斥）：互斥锁（任务通知不适合）。
- 二进制事件（"有数据了"、"按键按了"）：以前用二值信号量，现在用任务通知。

从 FreeRTOS V8.2.0 开始任务通知就是正式特性了。如果你的 MCU 跑的是 FreeRTOS V9 或 V10，直接用。
